// Not covered here: a real Postgres. The pg pool is only ever pointed at a closed port or at a stand-in listener that
// reads the first packet and hangs up, so a real TLS handshake, certificate checking, a password exchange, the
// 10 second connect timeout and the server applying statement_timeout are not run. Transactions are shown on the
// in-memory PGlite, which runs one statement at a time.
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectPostgres, openMemoryDb, StoreError, type Db } from '../src/db.ts';

const PASSWORD = 'Pa55-w0rd!only-here';
const ENCODED_PASSWORD = encodeURIComponent(PASSWORD);

async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, 'close');
  return port;
}

// Reads the first whole packet a client sends, hands it to the test, then hangs up.
async function standIn(host: string): Promise<{ server: Server; port: number; first: Promise<Buffer> }> {
  let deliver: (packet: Buffer) => void = () => undefined;
  const first = new Promise<Buffer>((resolve) => {
    deliver = resolve;
  });
  const server = createServer((socket: Socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= 4 && buffered.length >= buffered.readInt32BE(0)) {
        deliver(buffered.subarray(0, buffered.readInt32BE(0)));
        socket.destroy();
      }
    });
  });
  server.listen(0, host);
  await once(server, 'listening');
  return { server, port: (server.address() as { port: number }).port, first };
}

function startupParameters(packet: Buffer): Map<string, string> {
  const parts = packet.subarray(8).toString('utf8').split('\0');
  const parameters = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length && parts[index] !== ''; index += 2) {
    parameters.set(parts[index] as string, parts[index + 1] as string);
  }
  return parameters;
}

function expectNoSecret(error: unknown, url: string): void {
  expect(error).toBeInstanceOf(StoreError);
  const shown = [String(error), (error as Error).stack ?? '', inspect(error, { depth: 5 }), JSON.stringify(error)];
  for (const text of shown) {
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(ENCODED_PASSWORD);
    expect(text).not.toContain(url);
  }
  expect((error as Error).cause).toBeUndefined();
}

describe('connectPostgres', () => {
  it('refuses a URL that is not postgres:// or postgresql://, without repeating it', () => {
    for (const url of [
      `mysql://thuli:${ENCODED_PASSWORD}@db.example.com/thuli`,
      `postgres:/thuli:${ENCODED_PASSWORD}@db.example.com/thuli`,
      ` postgres://thuli:${ENCODED_PASSWORD}@db.example.com/thuli`,
      `postgres://thuli:${ENCODED_PASSWORD}@/thuli`,
      `postgres://thuli:${ENCODED_PASSWORD}%zz@db.example.com/thuli`,
      `postgres://thuli:${ENCODED_PASSWORD}@db.example.com:99999/thuli`,
    ]) {
      let thrown: unknown;
      try {
        connectPostgres(url);
      } catch (error) {
        thrown = error;
      }
      expectNoSecret(thrown, url);
    }
  });

  it('refuses a pool size that is not a whole number of at least 1', () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(() => connectPostgres('postgres://thuli@localhost/thuli', { max })).toThrow(StoreError);
    }
  });

  it('C40: a closed local port rejects with a message that holds neither the password nor the URL', async () => {
    const url = `postgres://thuli:${ENCODED_PASSWORD}@127.0.0.1:${await closedPort()}/thuli`;
    const db = connectPostgres(url);
    try {
      const thrown = await db.query('SELECT 1').then(
        () => undefined,
        (error: unknown) => error,
      );
      expectNoSecret(thrown, url);
      const inTransaction = await db.transaction(async () => 1).then(
        () => undefined,
        (error: unknown) => error,
      );
      expectNoSecret(inTransaction, url);
    } finally {
      await db.close();
    }
  });

  it('asks for TLS before anything else when the host is not localhost or 127.0.0.1', async () => {
    const { server, port, first } = await standIn('::1');
    const url = `postgres://thuli:${ENCODED_PASSWORD}@[::1]:${port}/thuli`;
    const db = connectPostgres(url);
    try {
      const failed = db.query('SELECT 1').then(
        () => undefined,
        (error: unknown) => error,
      );
      const packet = await first;
      // An SSLRequest is 8 bytes long and carries the code 80877103 where a startup message carries its protocol.
      expect(packet.length).toBe(8);
      expect(packet.readInt32BE(4)).toBe(80877103);
      expectNoSecret(await failed, url);
    } finally {
      await db.close();
      server.close();
    }
  });

  it('on localhost starts plain, asks for a 10 second statement timeout and does not send the password unasked', async () => {
    const { server, port, first } = await standIn('127.0.0.1');
    const url = `postgres://thuli:${ENCODED_PASSWORD}@localhost:${port}/thuli_db`;
    const db = connectPostgres(url);
    try {
      const failed = db.query('SELECT 1').then(
        () => undefined,
        (error: unknown) => error,
      );
      const packet = await first;
      expect(packet.readInt32BE(4)).toBe(196608);
      const parameters = startupParameters(packet);
      expect(parameters.get('user')).toBe('thuli');
      expect(parameters.get('database')).toBe('thuli_db');
      expect(parameters.get('statement_timeout')).toBe('10000');
      expect(packet.toString('utf8')).not.toContain(PASSWORD);
      expectNoSecret(await failed, url);
    } finally {
      await db.close();
      server.close();
    }
  });
});

describe('openMemoryDb transactions', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMemoryDb();
    await db.query('CREATE TABLE notes (body text NOT NULL)');
  });
  afterAll(async () => {
    await db.close();
  });

  async function bodies(): Promise<string[]> {
    return (await db.query<{ body: string }>('SELECT body FROM notes ORDER BY body')).map((row) => row.body);
  }

  it('commits when fn resolves and hands back its value', async () => {
    await db.query('DELETE FROM notes');
    const value = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO notes (body) VALUES ($1)', ['kept']);
      return 7;
    });
    expect(value).toBe(7);
    expect(await bodies()).toEqual(['kept']);
  });

  it('rolls back when fn throws and rethrows that same error', async () => {
    await db.query('DELETE FROM notes');
    const mine = new Error('stop here');
    const thrown = await db
      .transaction(async (tx) => {
        await tx.query('INSERT INTO notes (body) VALUES ($1)', ['dropped']);
        throw mine;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(thrown).toBe(mine);
    expect(await bodies()).toEqual([]);
  });

  it('refuses to commit when a failed statement was caught inside fn', async () => {
    await db.query('DELETE FROM notes');
    const thrown = await db
      .transaction(async (tx) => {
        await tx.query('INSERT INTO notes (body) VALUES ($1)', ['dropped']);
        await tx.query('INSERT INTO notes (body) VALUES ($1)', [null]).catch(() => undefined);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(StoreError);
    expect(await bodies()).toEqual([]);
  });

  it('refuses a transaction used after it ended, and a statement error comes back as StoreError with its code', async () => {
    let escaped: { query: Db['query'] } | undefined;
    await db.transaction(async (tx) => {
      escaped = tx;
    });
    await expect(escaped?.query('SELECT 1')).rejects.toThrow(/used after it ended/);
    await expect(db.query('SELECT 1 / 0')).rejects.toThrow(/\(22012\)$/);
  });

  it('refuses every call once closed', async () => {
    const other = await openMemoryDb();
    await other.close();
    await other.close();
    await expect(other.query('SELECT 1')).rejects.toThrow(StoreError);
    await expect(other.transaction(async () => 1)).rejects.toThrow(StoreError);
  });
});

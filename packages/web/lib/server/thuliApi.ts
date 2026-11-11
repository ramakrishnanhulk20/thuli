// The paid and free API, mounted inside the site. Only the two route handlers under app/api import this; no page or
// component may, so nothing of it reaches a browser.
import { siteApi, type SiteApi } from '@thuli/api/site';

// Carried inside the server bundle as text, so they load wherever the built site runs, whatever path a host gives its
// files. The ?raw query is what next.config.ts's text rule and Vite both read. Each file is taken as a whole module:
// a production build renames a text module's one export, and glob's own import option still asks for "default".
const rulebooks = import.meta.glob<Record<string, unknown>>('../../../rulebook/thuli-rulebook.md', { query: '?raw', eager: true });
const migrations = import.meta.glob<Record<string, unknown>>('../../../store/migrations/*.sql', { query: '?raw', eager: true });

/** A text module's contents: its one string export, whatever the build named it. Empty when there is not exactly one. */
function textOf(module: Record<string, unknown> | undefined): string {
  const texts = Object.values(module ?? {}).filter((value): value is string => typeof value === 'string');
  return texts.length === 1 ? (texts[0] as string) : '';
}

/** The glob's keys are paths; the store knows its migrations by file name. */
function byFileName(files: Record<string, Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([key, module]) => [key.slice(key.lastIndexOf('/') + 1), textOf(module)]));
}

let api: SiteApi | undefined;

/**
 * The one API for this server copy: built from process.env on the first request and reused for every request after.
 * With a setting missing or forbidden it is an API that answers 503 {busy: true} to everything (see siteApi).
 */
export function thuliApi(): SiteApi {
  api ??= siteApi(process.env, {
    // An empty rulebook, from a build that could not find the file, is refused by the screening as a setting.
    rulebook: textOf(Object.values(rulebooks)[0]),
    migrations: byFileName(migrations),
  });
  return api;
}

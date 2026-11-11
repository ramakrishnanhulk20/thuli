import { Anek_Tamil, Hanken_Grotesk, IBM_Plex_Mono } from 'next/font/google';

export const display = Anek_Tamil({ subsets: ['latin', 'tamil'], axes: ['wdth'], display: 'swap', variable: '--ff-display' });
export const body = Hanken_Grotesk({ subsets: ['latin'], display: 'swap', variable: '--ff-body' });
export const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], display: 'swap', variable: '--ff-mono' });

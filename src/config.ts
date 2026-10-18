/**
 * Central place for runtime configuration, overridable via environment variables.
 */

export const PORT: number = Number(process.env.PORT ?? 3000);

export const HOST: string = process.env.HOST ?? '0.0.0.0';

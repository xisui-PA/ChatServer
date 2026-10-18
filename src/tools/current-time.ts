import { Tool, ToolDefinition, toolArguments } from './interface';

export class CurrentTimeTool implements Tool {
  public readonly definition: ToolDefinition = {
    type: 'function',
    name: 'current_time',
    description: 'Get the actual current time, date, and weekday in an IANA timezone, e.g. America/Los_Angeles. Pass null for UTC.',
    parameters: {
      type: 'object',
      properties: { timezone: { type: ['string', 'null'] } },
      required: ['timezone'],
      additionalProperties: false
    },
    strict: true
  };

  public execute(args: unknown): Promise<unknown> {
    const values = toolArguments(args, ['timezone']);
    const timezone = values.timezone ?? 'UTC';
    if (typeof timezone !== 'string' || !timezone.trim() || timezone.length > 100) {
      throw new Error('timezone must be an IANA timezone string or null.');
    }
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long'
    });
    const now = new Date();
    return Promise.resolve({
      timezone: formatter.resolvedOptions().timeZone,
      local: formatter.format(now),
      utc: now.toISOString(),
      unixMilliseconds: now.getTime()
    });
  }
}

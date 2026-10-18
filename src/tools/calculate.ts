import { Tool, ToolDefinition, stringArgument, toolArguments } from './interface';

interface MathFunction {
  minimum: number;
  maximum: number;
  call: (...values: number[]) => number;
}

const functions = new Map<string, MathFunction>([
  ...Object.entries({
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, ln: Math.log,
    log: Math.log10, exp: Math.exp
  }).map(([name, call]): [string, MathFunction] => [name, { minimum: 1, maximum: 1, call }]),
  ['pow', { minimum: 2, maximum: 2, call: Math.pow }],
  ['min', { minimum: 1, maximum: 16, call: Math.min }],
  ['max', { minimum: 1, maximum: 16, call: Math.max }]
]);

/** A bounded arithmetic grammar. Never evaluates JavaScript or accesses properties. */
class ExpressionParser {
  private readonly tokens: string[] = [];
  private position = 0;

  public constructor(expression: string) {
    let rest = expression;
    while (rest.trim()) {
      const token = /^\s*(\*\*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-z]+|[+\-*/%^(),])/.exec(rest);
      if (!token) {
        throw new Error('Invalid arithmetic token.');
      }
      this.tokens.push(token[1]);
      if (this.tokens.length > 256) {
        throw new Error('Expression exceeds 256 tokens.');
      }
      rest = rest.slice(token[0].length);
    }
  }

  public evaluate(): number {
    const result = this.sum();
    if (this.position !== this.tokens.length) {
      throw new Error('Unexpected trailing arithmetic input.');
    }
    if (!Number.isFinite(result)) {
      throw new Error('Calculation produced a nonfinite result.');
    }
    return result;
  }

  private take(token: string): boolean {
    if (this.tokens[this.position] !== token) {
      return false;
    }
    this.position += 1;
    return true;
  }

  private expect(token: string): void {
    if (!this.take(token)) {
      throw new Error(`Expected "${token}" in expression.`);
    }
  }

  private sum(): number {
    let value = this.product();
    for (;;) {
      if (this.take('+')) {
        value += this.product();
      } else if (this.take('-')) {
        value -= this.product();
      } else {
        return value;
      }
      if (!Number.isFinite(value)) {
        throw new Error('Calculation produced a nonfinite intermediate result.');
      }
    }
  }

  private product(): number {
    let value = this.unary();
    for (;;) {
      if (this.take('*')) {
        value *= this.unary();
      } else if (this.take('/')) {
        const divisor = this.unary();
        if (divisor === 0) {
          throw new Error('Division by zero.');
        }
        value /= divisor;
      } else if (this.take('%')) {
        const divisor = this.unary();
        if (divisor === 0) {
          throw new Error('Modulo by zero.');
        }
        value %= divisor;
      } else {
        return value;
      }
      if (!Number.isFinite(value)) {
        throw new Error('Calculation produced a nonfinite intermediate result.');
      }
    }
  }

  private unary(): number {
    if (this.take('+')) {
      return this.unary();
    }
    if (this.take('-')) {
      return -this.unary();
    }
    const base = this.primary();
    const result = this.take('^') || this.take('**') ? base ** this.unary() : base;
    if (!Number.isFinite(result)) {
      throw new Error('Calculation produced a nonfinite result.');
    }
    return result;
  }

  private primary(): number {
    if (this.take('(')) {
      const result = this.sum();
      this.expect(')');
      return result;
    }
    const token = this.tokens[this.position++];
    if (token === undefined) {
      throw new Error('Expected an arithmetic value.');
    }
    if (/^(?:\d|\.)/.test(token)) {
      return Number(token);
    }
    if (token === 'pi' || token === 'e') {
      return token === 'pi' ? Math.PI : Math.E;
    }
    const fn = functions.get(token);
    if (fn === undefined) {
      throw new Error(`Unknown arithmetic function "${token}".`);
    }
    this.expect('(');
    const args: number[] = [];
    if (!this.take(')')) {
      do {
        args.push(this.sum());
      } while (this.take(','));
      this.expect(')');
    }
    if (args.length < fn.minimum || args.length > fn.maximum) {
      throw new Error(`Wrong number of arguments for ${token}.`);
    }
    const result = fn.call(...args);
    if (!Number.isFinite(result)) {
      throw new Error(`Invalid input or nonfinite result for ${token}.`);
    }
    return result;
  }
}

export class CalculateTool implements Tool {
  public readonly definition: ToolDefinition = {
    type: 'function',
    name: 'calculate',
    description: 'Evaluate arithmetic: + - * / % (modulo), ^ or ** (power), parentheses, pi, e, sqrt, abs, sin/cos/tan (radians), floor, ceil, round, ln, log (base 10), exp, min, max, pow. Uses floating-point numbers.',
    parameters: {
      type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false
    },
    strict: true
  };

  public execute(args: unknown): Promise<unknown> {
    const values = toolArguments(args, ['expression']);
    const expression = stringArgument(values, 'expression', 1000);
    return Promise.resolve({ expression, result: new ExpressionParser(expression).evaluate() });
  }
}

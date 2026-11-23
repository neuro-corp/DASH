export interface ToolDefinitionLike {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutionMetadata {
  executionTime: number;
  cached: boolean;
}

export type ToolExecutionResult<T = unknown> = {
  success: true;
  toolName: string;
  data: T;
  metadata: ToolExecutionMetadata;
} | {
  success: false;
  toolName: string;
  error: string;
  errorCode: 'unknown_tool' | 'invalid_arguments' | 'tool_failed';
  cause?: unknown;
  metadata: ToolExecutionMetadata;
};

export type ToolHandler<Context = unknown, Result = unknown> = (args: Record<string, unknown>, context: Context) => Promise<Result> | Result;

interface RegisteredTool<Context> {
  definition: ToolDefinitionLike;
  handler: ToolHandler<Context>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(schema: Record<string, unknown>, location: string): string | undefined {
  const allowedTypes = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean']);
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !allowedTypes.has(schema.type))) {
    return `${location} has an unsupported schema type.`;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return `${location}.enum must be a non-empty array.`;
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) return `${location}.properties must be an object.`;
  if (schema.required !== undefined && !Array.isArray(schema.required)) return `${location}.required must be an array.`;
  if (Array.isArray(schema.required) && !isRecord(schema.properties) && schema.required.length > 0) {
    return `${location}.required contains an unknown property.`;
  }
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (typeof name !== 'string' || !(name in schema.properties)) return `${location}.required contains an unknown property.`;
    }
    for (const [name, property] of Object.entries(schema.properties)) {
      if (!isRecord(property)) return `${location}.properties.${name} must be a schema object.`;
      const error = schemaError(property, `${location}.properties.${name}`);
      if (error) return error;
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) return `${location}.items must be a schema object.`;
    const error = schemaError(schema.items, `${location}.items`);
    if (error) return error;
  }
  return undefined;
}

function validateValue(value: unknown, schema: Record<string, unknown>, key: string): string | undefined {
  const type = schema.type;
  if (type === 'string' && typeof value !== 'string') return `${key} must be a string.`;
  if (type === 'boolean' && typeof value !== 'boolean') return `${key} must be a boolean.`;
  if (type === 'integer' && (!Number.isInteger(value))) return `${key} must be an integer.`;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${key} must be a number.`;
  if (type === 'object' && !isRecord(value)) return `${key} must be an object.`;
  if (type === 'array' && !Array.isArray(value)) return `${key} must be an array.`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${key} must be one of the allowed values.`;
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${key} is too short.`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${key} is too long.`;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${key} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${key} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${key} must contain at least ${schema.minItems} item(s).`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${key} must contain at most ${schema.maxItems} item(s).`;
    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const error = validateValue(value[index], schema.items, `${key}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const field of required) if (!(field in value)) return `${key}.${field} is required.`;
    for (const [field, fieldValue] of Object.entries(value)) {
      const fieldSchema = schema.properties[field];
      if (!fieldSchema) {
        if (schema.additionalProperties === false) return `${key}.${field} is not allowed.`;
        continue;
      }
      if (isRecord(fieldSchema)) {
        const error = validateValue(fieldValue, fieldSchema, `${key}.${field}`);
        if (error) return error;
      }
    }
  }
  return undefined;
}

function resultIsCached(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return false;
    if (parsed.cached === true || parsed.fromCache === true || parsed.unchanged === true) return true;
    return Array.isArray(parsed.files) && parsed.files.some(entry => isRecord(entry) && (entry.fromCache === true || entry.unchanged === true));
  } catch { return false; }
}

export class ToolRegistry<Context = unknown> {
  private readonly tools = new Map<string, RegisteredTool<Context>>();

  register(definition: ToolDefinitionLike, handler: ToolHandler<Context>): void {
    const name = definition?.function?.name;
    const parameters = definition?.function?.parameters;
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid canonical tool name: ${String(name)}.`);
    if (!definition.function.description || !isRecord(parameters) || parameters.type !== 'object') {
      throw new Error(`Tool ${name} must have a description and an object input schema.`);
    }
    const invalidSchema = schemaError(parameters, `${name}.parameters`);
    if (invalidSchema) throw new Error(`Invalid schema for ${name}: ${invalidSchema}`);
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered.`);
    if (typeof handler !== 'function') throw new Error(`Tool ${name} has no executable handler.`);
    this.tools.set(name, { definition, handler });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinitionLike | undefined {
    return this.tools.get(name)?.definition;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): ToolDefinitionLike[] {
    return [...this.tools.values()].map(tool => tool.definition);
  }

  getDefinitions(): ToolDefinitionLike[] {
    return this.getAll();
  }

  validate(name: string, rawArgs: string): { success: true; args: Record<string, unknown> } | { success: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, error: `Unknown tool: ${name}.` };
    let parsed: unknown;
    try { parsed = JSON.parse(rawArgs || '{}'); } catch (error) {
      return { success: false, error: `Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!isRecord(parsed)) return { success: false, error: 'Tool arguments must be a JSON object.' };
    // Keep the longstanding convenience accepted by write_file: callers may
    // provide string[] content, which the handler joins with newlines.
    if (name === 'write_file' && 'content' in parsed) {
      const { content: _content, ...rest } = parsed;
      const error = validateValue({ ...rest, content: '' }, tool.definition.function.parameters, 'arguments');
      return error ? { success: false, error } : { success: true, args: parsed };
    }
    const error = validateValue(parsed, tool.definition.function.parameters, 'arguments');
    return error ? { success: false, error } : { success: true, args: parsed };
  }

  async execute(name: string, rawArgs: string, context: Context): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) return { success: false, toolName: name, error: `Unknown tool: ${name}.`, errorCode: 'unknown_tool', metadata: { executionTime: 0, cached: false } };
    const parsed = this.validate(name, rawArgs);
    if (!parsed.success) return { success: false, toolName: name, error: parsed.error, errorCode: 'invalid_arguments', metadata: { executionTime: Date.now() - startedAt, cached: false } };
    try {
      const data = await tool.handler(parsed.args, context);
      return { success: true, toolName: name, data, metadata: { executionTime: Date.now() - startedAt, cached: resultIsCached(data) } };
    } catch (error) {
      return {
        success: false,
        toolName: name,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'tool_failed',
        cause: error,
        metadata: { executionTime: Date.now() - startedAt, cached: false },
      };
    }
  }
}

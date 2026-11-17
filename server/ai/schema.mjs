import { AppError } from '../errors.mjs';

export const str = (maxLength = 3000) => ({ type: 'string', minLength: 1, maxLength });
export const num = (minimum = 0, maximum = 100) => ({ type: 'number', minimum, maximum });
export const enumeration = (values) => ({ type: 'string', enum: values });
export const arr = (items, maxItems = 10, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
export const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export function validate(schema, value, path = '$') {
  const fail = () => { throw new AppError(502, 'INVALID_AI_OUTPUT', `The AI provider returned an invalid structured response at ${path}.`); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const key of schema.required || []) if (!(key in value)) fail();
    for (const [key, val] of Object.entries(value)) {
      if (!schema.properties[key]) { if (schema.additionalProperties === false) fail(); }
      else validate(schema.properties[key], val, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) fail();
    value.forEach((val, i) => validate(schema.items, val, `${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity)) fail();
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) fail();
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) fail();
  }
  if (schema.enum && !schema.enum.includes(value)) fail();
  return value;
}

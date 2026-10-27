// Zod schemas as Fastify route schemas (NFR-3, ADR-04). Route schemas are Zod
// objects; the validator compiler runs safeParse and hands Fastify the parsed
// (and therefore typed, coerced and stripped) value. Strict objects reject
// unknown fields.
import type { FastifySchemaCompiler } from 'fastify';
import type { ZodType } from 'zod';

export const zodValidatorCompiler: FastifySchemaCompiler<ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { error: Object.assign(new Error('validation failed'), { validation: issues, statusCode: 400 }) };
  };

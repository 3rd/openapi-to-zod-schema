import assert from "node:assert/strict";
import { codegen, convertOpenAPISpecToZodSchemas, type OpenAPISpec } from "openapi-to-zod-schema";
import { z } from "zod";

const spec: OpenAPISpec = {
  components: {
    schemas: { Message: { type: "string" } },
  },
};
const schemas = convertOpenAPISpecToZodSchemas(spec);
const messagesSchema = z.array(schemas.map.Message);
assert.deepEqual(messagesSchema.parse(["hello"]), ["hello"]);
assert.equal(messagesSchema.safeParse([123]).success, false);
assert.match(codegen(spec), /export const MessageSchema = z\.string\(\)/);

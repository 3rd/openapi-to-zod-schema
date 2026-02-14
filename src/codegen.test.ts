import { codegen } from "./codegen";

describe("codegen", () => {
  it("generates schema with refs", () => {
    const spec = {
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              email: { type: "string" },
              roles: { type: "array", items: { type: "string" } },
            },
            required: ["id", "email"],
          },
          Post: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              content: { type: "string" },
              author: { $ref: "#/components/schemas/User" },
            },
            required: ["id", "title", "content", "author"],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const UserSchema = z.object({
        id: z.number(),
        name: z.string().optional(),
        email: z.string(),
        roles: z.array(z.string()).optional()
      });

      export const PostSchema = z.object({
        id: z.number(),
        title: z.string(),
        content: z.string(),
        author: UserSchema
      });"
    `);
  });

  it("generates schema with nested objects and nullable properties", () => {
    const spec = {
      components: {
        schemas: {
          Sample: {
            type: "object",
            properties: {
              nested: {
                type: "object",
                nullable: true,
                properties: {
                  "deep-Prop": { type: "string" },
                },
              },
            },
            required: ["nested"],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const SampleSchema = z.object({
        nested: z.object({
          "deep-Prop": z.string().optional()
        }).nullable()
      });"
    `);
  });
  it("generates union schema with discriminator", () => {
    const spec = {
      components: {
        schemas: {
          User: {
            oneOf: [
              {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  kind: { type: "string", enum: ["user"] },
                  name: { type: "string" },
                },
                required: ["id", "kind"],
              },
              {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  kind: { type: "string", enum: ["systemuser"] },
                  system: { type: "string" },
                },
                required: ["id", "kind"],
              },
            ],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const UserSchema = z.discriminatedUnion("kind", [z.object({
        id: z.number(),
        kind: z.literal("user"),
        name: z.string().optional()
      }), z.object({
        id: z.number(),
        kind: z.literal("systemuser"),
        system: z.string().optional()
      })]);"
    `);
  });
  it("generates union schema with discriminator for referenced schemas", () => {
    const spec = {
      components: {
        schemas: {
          SystemUser: {
            type: "object",
            properties: {
              id: { type: "integer" },
              kind: { type: "string", enum: ["systemuser"] },
              system: { type: "string" },
            },
            required: ["id", "kind"],
          },
          User: {
            oneOf: [
              {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  kind: { type: "string", enum: ["user"] },
                  name: { type: "string" },
                },
                required: ["id", "kind"],
              },
              {
                $ref: "#/components/schemas/SystemUser",
              },
            ],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const SystemUserSchema = z.object({
        id: z.number(),
        kind: z.literal("systemuser"),
        system: z.string().optional()
      });

      export const UserSchema = z.discriminatedUnion("kind", [z.object({
        id: z.number(),
        kind: z.literal("user"),
        name: z.string().optional()
      }), SystemUserSchema]);"
    `);
  });
});

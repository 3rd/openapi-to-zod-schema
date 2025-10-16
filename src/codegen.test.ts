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

  it("generates schema with additional checks on string properties", () => {
    const spec = {
      components: {
        schemas: {
          Sample: {
            type: "object",
            properties: {
              prop: {
                type: "string",
                minLength: 1,
                maxLength: 5,
              },
              dateprop: {
                type: "string",
                format: "date",
              },
            },
            required: ["prop", "dateprop"],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const SampleSchema = z.object({
        prop: z.string().min(1).max(5),
        dateprop: z.string().date()
      });"
    `);
  });
});

# OpenAPI to Zod Schema

This package provides a CLI and library to convert the supported schema features in the `components.schemas` section of an OpenAPI 3.0 document into Zod 4 schemas, either as runtime schema objects or as generated TypeScript source code.

## Features

- Convert OpenAPI schemas (YAML or JSON) to Zod schemas
- Support for `allOf`, `oneOf`, `anyOf`, and `$ref` (including circular references)
- String, numeric, and boolean enums, integer validation, `nullable`, and `additionalProperties`
- String `minLength`, `maxLength`, and `format: date` validation
- CLI tool for easy conversion from the command line
- Support for both local files and remote URLs as input

## Installation

Requires Node.js newer than 24.11.0.

You can install the package from [NPM](https://www.npmjs.com/package/openapi-to-zod-schema):

```bash
# install (Zod 4.5 or newer within major version 4 is a required peer dependency)
npm i -D openapi-to-zod-schema zod@^4.5.0

# or run it directly
npx openapi-to-zod-schema https://raw.githubusercontent.com/openai/openai-openapi/refs/heads/manual_spec/openapi.yaml
npx openapi-to-zod-schema ./openapi.yaml -o openai-schemas.ts
```

## Usage

### As a Library

```typescript
import { convertOpenAPISpecToZodSchemas, codegen } from "openapi-to-zod-schema";

const openAPISpec = {
  components: {
    schemas: {
      User: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
};

// Runtime Zod schemas, keyed by schema name
const { map, items } = convertOpenAPISpecToZodSchemas(openAPISpec);
map.User.parse({ id: "user-1" });

// Generated TypeScript source code
const code = codegen(openAPISpec);
console.log(code);
// import { z } from 'zod';
//
// export const UserSchema = z.object({
//   id: z.string()
// });
```

A schema that declares `properties` without a `type` is converted as an object, unless it has an `enum`. Objects with declared properties strip undeclared keys from parsed output by default. Set `additionalProperties: true` to preserve them, `false` to reject them, or provide a schema to validate their values. A free-form object on its own preserves its contents unless `additionalProperties` restricts them. Composition can change this behavior, as described below. For an enum, `nullable: true` permits `null` even when the enum does not list it.

Schemas with `type: string` preserve `minLength`, `maxLength`, and `format: date` in both runtime schemas and generated code. Length counts Unicode code points, so `😀` counts as one and `e` followed by a combining accent counts as two. Dates must be valid `YYYY-MM-DD` strings; they are not converted to JavaScript `Date` objects. String enum values must also satisfy these constraints. If these constraints exclude every member of a supported enum, the schema rejects every value except `null` when `nullable: true`.

A required property with an unconstrained schema must be present, but its value may be `undefined` when validating JavaScript objects. A required name that the object does not declare must be present too, and its value is validated as an additional property. An object closed with `additionalProperties: false` cannot contain such a name, so the requirement is ignored with a warning.

A member of an object schema's `allOf`, `anyOf`, or `oneOf` that only lists required names, such as `oneOf: [{ required: [a] }, { required: [b] }]`, applies to that object. An `allOf` member adds its names to the object's required names. An `anyOf` or `oneOf` whose members are all of this kind produces one alternative of the object per member. When the object also composes other schemas, the object's own `properties` must declare every name these members list: an `allOf` member that names another property is ignored, and so is an `anyOf` or `oneOf` that has such a member. Anywhere else, `required` without a `type` or `properties` is ignored.

Empty `oneOf` and `anyOf` arrays convert to `z.never()` and reject every value, subject to the nullability rules below.

`allOf` combines validation constraints rather than letting one override another. Unknown keys on the object being intersected are an exception: Zod rejects a key only when every intersected member rejects it. For objects closed with `additionalProperties: false`, that means:

- Closed objects combined with each other accept the keys that any of them declares and reject all others, so a closed base schema can be extended through `allOf`. Required fields and value constraints still apply.
- Constraints converted directly to `z.unknown()` are omitted. A bare `type: object` is also omitted when another constraint that is not itself a bare object type guarantees an object, either for the schema's own type or for a direct `allOf` member without its own compositions. Here, bare means no `$ref`, declared properties, required fields, `additionalProperties`, enum, or nullability. This keeps a `type: object` wrapper around closed `oneOf` alternatives from admitting extra keys.
- An object schema that remains in the intersection can allow keys a closed member does not declare. Those keys must satisfy any constraints imposed by the other members and are stripped from parsed output unless another member preserves them. An explicit `additionalProperties: true` is not a bare object and is retained.

The same applies when a schema's own type is combined with a sibling `allOf`, `anyOf`, or `oneOf`. An outer intersection does not suppress unknown-key errors from nested objects in properties or array items; if a nested object is itself an intersection, these same rules apply at that level. Zod merges the members' parsed outputs: a member that preserves extra keys can retain them in the combined output even when another member strips them.

### As a CLI Tool

```bash
npx openapi-to-zod-schema ./path/to/your/openapi-spec.yaml
```

Or for remote files:

```bash
npx openapi-to-zod-schema https://example.com/path/to/openapi-spec.yaml
```

By default, the CLI tool prints the generated Zod schemas to stdout. Use `-o` to write them to a file instead:

```bash
npx openapi-to-zod-schema ./path/to/your/openapi-spec.yaml -o ./output-schema.ts
```

Use `--prefix` to prepend a prefix to every generated schema name:

```bash
npx openapi-to-zod-schema ./openapi.yaml --prefix Api
# generates: export const ApiUserSchema = ...
```

Inputs ending in `.yaml`/`.yml` are parsed as YAML and `.json` as JSON; for other inputs (for example extensionless URLs) the CLI detects the format from the content.

The CLI checks the containers and schema fields needed for safe conversion, reporting malformed structures with a JSON-pointer path such as `#/components/schemas/Pet/properties/name`. Unsupported `type`, `nullable`, and `enum` value shapes are ignored with warnings. On string schemas, invalid `minLength`, `maxLength`, and `format` values are also ignored with warnings: lengths must be nonnegative integers and formats must be strings. A schema whose `type` is ignored stays unconstrained by its `properties`. Empty YAML values in component schemas, properties, and array items count as absent. Documents without `components.schemas` generate no schema declarations; this is not a full OpenAPI document validator.

## API Reference

### `convertOpenAPISpecToZodSchemas(spec: OpenAPISpec): { map, items }`

Converts an OpenAPI specification to runtime Zod schemas.

- `spec`: The OpenAPI specification object (only `components.schemas` is read).
- Returns: An object containing:
  - `map`: `Record<string, z.ZodType>` of schema names to their Zod schemas.
  - `items`: `Array<{ name: string, schema: z.ZodType }>` with the same entries in order.

Example:

```typescript
const { map, items } = convertOpenAPISpecToZodSchemas(openAPISpec);

console.log(map.User); // Zod schema for the "User" component schema
console.log(items[0]); // { name: "User", schema: ZodSchema }
```

### `codegen(spec: OpenAPISpec, prefix?: string): string`

Generates TypeScript source code defining the Zod schemas.

- `spec`: The OpenAPI specification object.
- `prefix` (optional): Prefix prepended to every generated schema constant name.
- Returns: A string containing the generated TypeScript code. The prefix and schema name are combined before invalid identifier characters are replaced (for example `user-profile` becomes `user_profileSchema`, while prefix `Api` and name `123name` become `Api123nameSchema`). Valid identifiers, including Unicode names, are preserved; sanitized names receive numeric suffixes when needed to avoid collisions.

Example:

```typescript
const code = codegen(openAPISpec, "Api");
// export const ApiUserSchema = z.object({ ... });
```

## Limitations

- Only `components.schemas` is converted; paths, operations, parameters, and responses are ignored.
- `oneOf` uses union validation rather than requiring exactly one matching variant. Generated code can use `z.discriminatedUnion` when object variants share a required literal-valued property with distinct values; the OpenAPI `discriminator` keyword is not interpreted.
- `pattern`, `minimum`, `maximum`, and formats other than `date` are not carried over.
- Numeric schemas accept only finite numbers. Integer schemas use Zod's safe-integer range, from `Number.MIN_SAFE_INTEGER` through `Number.MAX_SAFE_INTEGER`.
- `additionalProperties: false` uses `z.strictObject`. A closed object on its own rejects unknown keys. In an intersection, it can accept keys it does not declare when another retained member allows them, including when the closed object is an `anyOf` or `oneOf` alternative. See the composition rules above.
- Zod does not validate an object property declared as `__proto__`: it is not required, its value is not checked, and it is absent from parsed output. Component schema names such as `__proto__` are supported.
- `nullable: true` adds `null` to a schema's own `type`, written or implied by `properties`, or to its `enum`; other constraints in the same schema, such as `allOf` members, can still exclude `null`. On a schema with neither a `type` nor an `enum`, such as a `$ref` or a composition on its own, it makes the whole schema nullable, although OpenAPI 3.0 defines `nullable` only alongside a `type`.
- Enums support strings, finite numbers, booleans, and `null`. An enum containing unsupported values (such as objects or arrays) degrades to `z.unknown()` with a warning. Members incompatible with a declared type are excluded with a warning.
- Unknown schema constructs degrade to `z.unknown()`. Unresolvable `$ref`s do so with a `console.warn`; only refs of the form `#/components/schemas/<Name>` are resolved.
- Generated recursive references retain runtime validation, but their recursive edges use `unknown` in TypeScript rather than inferring a recursive domain type.
- Reference cycles that never descend into an object property or array item (for example a schema that references only itself) are cut to `z.unknown()` with a warning. A cut branch in `oneOf` or `anyOf` makes that union accept any value; this is unsupported-schema degradation, not meaningful validation of the cycle.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.

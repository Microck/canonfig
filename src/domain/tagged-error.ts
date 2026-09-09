import { inspect, type InspectOptions } from "node:util";

import { type Cause, Schema } from "effect";

/**
 * The one declaration pattern for tagged errors in this repository.
 *
 * `Schema.TaggedError` hands only a declared `message` field to `Error`, so a
 * class that declares none carries `message === ""`. Its stack header and
 * `String(error)` are then the bare tag, and Node's uncaught-exception printer
 * lists only the enumerable fields, because the empty `message` is a
 * non-enumerable own property. Effect also replaces Node's error inspection
 * with a fields-only object, which drops the header and the stack from
 * `console.error` and `util.inspect` for every error class. Together these made
 * a CI failure undiagnosable: two errors printed as `{ _tag, ...fields }` with
 * no message and no origin.
 *
 * This wrapper fixes both once, for every error class:
 *
 * - a class without a `message` field renders its declared fields as the
 *   message. A class that declares `message` keeps it verbatim: `Error` sets an
 *   own `message` property, which shadows the prototype getter defined here;
 * - inspection uses Node's native error rendering (header, stack, fields).
 *
 * Schema behavior is unchanged: `message` stays outside the encoded fields, and
 * `_tag`, `catchTag`, `toJSON` and decoding work exactly as before.
 */
export const TaggedError = <Self = never>() =>
  <Tag extends string, const Fields extends Schema.Struct.Fields>(
    tag: Tag,
    fields: Fields,
  ): Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Cause.YieldableError> => {
    // SAFETY: Effect types this call as an error string until `Self` is bound,
    // which never happens inside a generic wrapper. The runtime value is always
    // the class, and the type below is the one Effect assigns at the
    // declaration site, plus the `prototype` every class has.
    const Base = Schema.TaggedError<Self>()(tag, fields) as
      & Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Cause.YieldableError>
      & { readonly prototype: object };
    Object.defineProperties(Base.prototype, {
      message: {
        // The enumerable own properties are `_tag` and the declared fields, in
        // declaration order; `message` and `stack` are non-enumerable.
        get(this: Error) {
          return Object.entries(this)
            .filter(([name]) => name !== "_tag")
            .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
            .join(" ");
        },
        configurable: true,
      },
      [inspect.custom]: {
        value(
          this: Error,
          depth: number,
          options: InspectOptions,
          inspectValue: typeof inspect,
        ) {
          return inspectValue(this, { ...options, depth, customInspect: false });
        },
        configurable: true,
      },
    });
    return Base;
  };

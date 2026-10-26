import type { Schema } from 'mongoose';

export class ImmutableRecordError extends Error {
  constructor(model: string) {
    super(`${model} records are immutable; record an adjustment instead`);
    this.name = 'ImmutableRecordError';
  }
}

const MUTATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

/**
 * Makes a collection append-only at the model layer: documents can be created, never changed or
 * deleted. Changes to money are recorded as new billing entries (adjustments) instead.
 */
export function immutablePlugin(schema: Schema, name: string): void {
  for (const op of MUTATIONS) {
    schema.pre(op, function () {
      throw new ImmutableRecordError(name);
    });
  }
  schema.pre('save', function () {
    if (!this.isNew) throw new ImmutableRecordError(name);
  });
}

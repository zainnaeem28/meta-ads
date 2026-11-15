import { v7 as uuidv7, validate, version } from 'uuid';

declare const brand: unique symbol;
/** A UUIDv7 identifier. The brand keeps ids of different entities from being mixed up by accident. */
export type Id<Entity extends string = string> = string & { readonly [brand]?: Entity };

export function newId<Entity extends string = string>(): Id<Entity> {
  return uuidv7() as Id<Entity>;
}

export function isUuidV7(value: unknown): value is Id {
  return typeof value === 'string' && validate(value) && version(value) === 7;
}

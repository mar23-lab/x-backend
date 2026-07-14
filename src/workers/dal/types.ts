// types.ts · Shared types for the backend DAL (Data Access Layer)
//
// Authority: API_CONTRACT_V1.md · DATABASE_SCHEMA_V1.md · R35.HARNESS-FLOW envelope
//
// These types are shared between WorkersDalAdapter (Neon) and LocalDalAdapter (static demo).
// The interface contract is the backend-agnostic seam from ADR-V3-002.
//
// §18/§19 A1 (2026-06-03): decomposed from a 1221-LOC god-file into 10 domain
// modules under ./types/. This file is now a barrel that re-exports all of them,
// so every importer keeps using the bare '.../dal/types' path unchanged (zero
// importer edits). Acyclic module graph: identity -> {all}; auth -> identity;
// event -> identity,auth; oauth -> identity; access -> identity,event; investor
// -> identity; synthetic-domain -> identity; planning -> identity,synthetic-domain;
// propagation -> identity,event,synthetic-domain,planning; inference -> identity,propagation.

export * from './types/identity';
export * from './types/auth';
export * from './types/event';
export * from './types/project-source';
export * from './types/oauth';
export * from './types/plan-entity';
export * from './types/access';
export * from './types/investor';
export * from './types/synthetic-domain';
export * from './types/planning';
export * from './types/propagation';
export * from './types/inference';
export * from './types/operational-spine';
export * from './types/template-policy';

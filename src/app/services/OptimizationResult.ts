import * as zod from 'zod';
import { Adresse } from '../data/adresse';

export interface OptimizationResult {
    readonly code: number;
    readonly routes: readonly VehiculeRoute[];
    readonly unassigned: unknown[];
    readonly summary: Readonly<{
        computing_times: Readonly<{
            loading: number;
            solving: number;
            routing: number;
        }>
        cost: number;
        duration: number;
        priority: number;
        service: number;
        setup: number;
        violations: readonly unknown[];
        waiting_time: number;
    }>,
}

export interface VehiculeRoute {
    readonly cost: number;
    readonly duration: number;
    readonly priority: number;
    readonly service: number;
    readonly setup: number;
    readonly vehicle: number;
    readonly violations: readonly unknown[];
    readonly waiting_time: number;
    readonly steps: readonly RouteStep[];
}

export interface RouteStepBase {
    // readonly type: "start" | "job" | "end";
    readonly arrival: number;
    // readonly id: number;
    readonly location: readonly [lng: number, lat: number];
    readonly service: number;
    readonly setup: number;
}

export interface RouteStepBaseStartEnd extends RouteStepBase {
    readonly type: "start" | "end";
}

export interface RouteStepBaseJob extends RouteStepBase {
    readonly type: "job";
    readonly id: number;
}

export type RouteStep = RouteStepBaseStartEnd | RouteStepBaseJob;

/**
 * ZOD schemas
 */
const RouteStepStartEndSchema = zod.object({
    type: zod.enum(["start", "end"]),
    arrival: zod.number(),
    location: zod.tuple([zod.number(), zod.number()]),
    service: zod.number(),
    setup: zod.number(),
});

const RouteStepJobSchema = zod.object({
    type: zod.literal("job"),
    arrival: zod.number(),
    id: zod.number(),
    location: zod.tuple([zod.number(), zod.number()]),
    service: zod.number(),
    setup: zod.number(),
});

const RouteStepSchema = zod.union([RouteStepStartEndSchema, RouteStepJobSchema]);

const VehiculeRouteSchema = zod.object({
    cost: zod.number(),
    duration: zod.number(),
    priority: zod.number(),
    service: zod.number(),
    setup: zod.number(),
    vehicle: zod.number(),
    violations: zod.array(zod.unknown()),
    waiting_time: zod.number(),
    steps: zod.array(RouteStepSchema),
});

const OptimizationResultSchema = zod.object({
    code: zod.number(),
    routes: zod.array(VehiculeRouteSchema),
    unassigned: zod.array(zod.unknown()),
    summary: zod.object({
        computing_times: zod.object({
            loading: zod.number(),
            solving: zod.number(),
            routing: zod.number(),
        }),
        cost: zod.number(),
        duration: zod.number(),
        priority: zod.number(),
        service: zod.number(),
        setup: zod.number(),
        violations: zod.array(zod.unknown()),
        waiting_time: zod.number(),
    }),
});

export function parseOptimizationResultP(data: unknown): Promise<OptimizationResult> {
    return OptimizationResultSchema.parseAsync(data);
}

export interface OptimizationReport {
  requestedVehicles: number;    // ce que l'utilisateur a demandé
  vehiclesUsed: number;         // ce qu'on utilise réellement
  minVehiclesNeeded: number;    // minimum calculé
  totalAddresses: number;       // total fourni
  assignedAddresses: number;    // effectivement dans une route
  unassignedAddresses: Adresse[]; // adresses non couvertes
  warnings: string[];           // messages explicatifs
}
/**
 * Single source of truth for the pi version used across the platform.
 *
 * Consumers:
 * - Worker image Dockerfile (ARG PI_VERSION, build-release injects)
 * - Service package.json dependency (@earendil-works/pi-ai)
 * - CI version-consistency check
 *
 * To upgrade pi: change this one constant, then rebuild worker image + service.
 */
export const PI_VERSION = "0.83.0" as const;

/**
 * Local-network multiplayer core (framework-free).
 *
 * NOTE: lanAdapter.ts is deliberately NOT re-exported here - importing it loads
 * native modules. Import it directly (and lazily) where a real network is needed:
 *   const { createLanAdapter } = require('./net/lanAdapter')
 */
export * from './transport';
export * from './timers';
export * from './protocol';
export * from './view';
export * from './clientSession';
export * from './hostSession';
export * from './memoryAdapter';

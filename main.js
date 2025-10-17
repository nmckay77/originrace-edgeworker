import { httpRequest } from 'http-request';
import { logger } from 'log';

/**
 * Akamai EdgeWorker: OriginRace
 * 
 * Dynamically selects the fastest backend origin server for each request by racing
 * multiple origins and caching the winner. Supports both synchronous and asynchronous
 * modes for different performance requirements.
 * 
 * This EdgeWorker uses the following input variables and stores output in a variable
 * for use in Property Manager:
 * 
 * Gets origin configuration from:
 * - PMUSER_ORIGIN_1..N                  : origin IDs (e.g., origin1, origin2, us-west, us-east) [REQUIRED]
 * - PMUSER_PROXY_DOMAIN                 : proxy domain for racing (e.g., .proxy.example.com) [REQUIRED]
 * - PMUSER_ORIGIN_DOMAIN                : domain suffix for routing (e.g., .example.com) [REQUIRED]
 * - PMUSER_RACE_CACHE_MINUTES           : cache TTL minutes (default 3)
 * - PMUSER_USE_STALE_RACE_CACHE         : use stale cache while refreshing? (default true)
 * - PMUSER_RACE_TIMEOUT_MS              : per-origin probe timeout in ms (default 500)
 * - PMUSER_RACE_CACHE_REFRESH_THRESHOLD : refresh threshold 0..1 (default 0.8)
 * - PMUSER_SYNC_ON_COLD                 : await race on cold start? (default true)
 * - PMUSER_RACE_URL                     : custom URL path for racing (default: use incoming request URL)
 * - PMUSER_RACE_METHOD                  : HTTP method for racing GET|HEAD (default HEAD)
 * 
 * Sets selected origin in:
 * - PMUSER_SELECTED_ORIGIN                : selected origin hostname for this request
 * 
 * Features:
 * - Load origins from PMUSER_ORIGIN_1..N
 * - Pick fastest origin via parallel HEAD/GET probes (Promise.any)
 * - Cold start modes:
 *   - Sync mode (default): Await race result before routing (accurate)
 *   - Async mode: Random selection + background race (can be faster due to no delay)
 * - Cached winner: serve immediately; refresh in background past threshold
 * - Stampede guard: one background race in-flight per process
 */

/**
 * Configuration constants with default values
 */
const DEFAULT_RACE_CACHE_MINUTES = 3;
const DEFAULT_RACE_TIMEOUT_MS = 500;
const DEFAULT_USE_STALE_RACE_CACHE = true;
const DEFAULT_RACE_CACHE_REFRESH_THRESHOLD = 0.8;
const DEFAULT_SYNC_ON_COLD = true;
const DEFAULT_RACE_METHOD = 'HEAD';

/**
 * Global variables for caching race results
 * @global {string} fastestOrigin - Cached fastest origin ID (best-effort per process)
 * @global {number} lastMeasurement - Frozen Date.now() (request start) when last race succeeded
 * @global {boolean} raceInFlight - True while a background race is running (gates extra races)
 */
let fastestOrigin = '';
let lastMeasurement = 0;
let raceInFlight = false;

/**
 * Main EdgeWorker entry point for client requests
 * 
 * Sets PMUSER_SELECTED_ORIGIN for this request by:
 * - Using cached winner (fresh or stale per flag)
 * - Running background refresh past threshold (gated)
 * - On cold start: either async (random+race) or sync (await race) per config
 * 
 * @param {Request} request - EdgeWorkers request object
 * @returns {Promise<void>}
 */
export async function onClientRequest(request) {
  const origins = loadOriginsFromConfig(request);
  if (!origins.length) {
    logger.warn('No PMUSER origins; letting PM handle routing');
    return;
  }
  logger.info('Origins=%d: %s', origins.length, origins.join(','));

  // Per-request config (PMUSER overrides) - validate required domains
  const proxyDomain = request.getVariable('PMUSER_PROXY_DOMAIN');
  const originDomain = request.getVariable('PMUSER_ORIGIN_DOMAIN');
  
  if (!proxyDomain) {
    logger.error('PMUSER_PROXY_DOMAIN is required but not set');
    return;
  }
  
  if (!originDomain) {
    logger.error('PMUSER_ORIGIN_DOMAIN is required but not set');
    return;
  }

  const cacheMinutes = parseInt(request.getVariable('PMUSER_RACE_CACHE_MINUTES') || DEFAULT_RACE_CACHE_MINUTES, 10);
  const cacheMs = cacheMinutes * 60 * 1000;
  const raceTimeoutMs = parseInt(request.getVariable('PMUSER_RACE_TIMEOUT_MS') || DEFAULT_RACE_TIMEOUT_MS, 10);
  
  const staleVar = request.getVariable('PMUSER_USE_STALE_RACE_CACHE');
  const useStale = staleVar === undefined ? DEFAULT_USE_STALE_RACE_CACHE : staleVar !== 'false';
  
  const syncVar = request.getVariable('PMUSER_SYNC_ON_COLD');
  const syncOnCold = syncVar === undefined ? DEFAULT_SYNC_ON_COLD : syncVar !== 'false';

  let refreshThreshold = parseFloat(request.getVariable('PMUSER_RACE_CACHE_REFRESH_THRESHOLD'));
  if (!(refreshThreshold >= 0 && refreshThreshold <= 1)) {
    refreshThreshold = DEFAULT_RACE_CACHE_REFRESH_THRESHOLD;
  }

  const now = Date.now(); // frozen per handler
  const cacheAge = now - lastMeasurement;

  // Cached winner path (fresh OR stale if allowed)
  if (fastestOrigin) {
    const host = `${fastestOrigin}${originDomain}`;
    const fresh = cacheAge < cacheMs;

    if (fresh || useStale) {
      logger.info(
        'Cache %s: %s age=%ds ttl=%ds',
        fresh ? 'hit' : 'stale',
        host,
        Math.floor(cacheAge / 1000),
        Math.floor(cacheMs / 1000)
      );

      request.setVariable('PMUSER_SELECTED_ORIGIN', host);

      // Background refresh past threshold (single-flight)
      if (cacheAge > cacheMs * refreshThreshold) {
        if (!raceInFlight) {
          raceInFlight = true;
          logger.debug(
            'Refresh: age=%ds thr=%ds ttl=%ds',
            Math.floor(cacheAge / 1000),
            Math.floor((cacheMs * refreshThreshold) / 1000),
            Math.floor(cacheMs / 1000)
          );
          fireAndForgetRace(request, origins, now, raceTimeoutMs).finally(() => {
            raceInFlight = false;
          });
        } else {
          logger.debug('Refresh skipped: race in-flight');
        }
      }
      return;
    }
    // else: stale not allowed => fall through to cold start handling
  }

  // No usable cache => cold start behavior based on syncOnCold
  
  if (syncOnCold) {
    // SYNC MODE: Wait for race result before routing
    logger.info('No cache => sync race (timeout=%dms)', raceTimeoutMs);
    const winner = await raceOrigins(request, origins, raceTimeoutMs);

    if (winner) {
      fastestOrigin = winner;
      lastMeasurement = now;
      const host = `${winner}${originDomain}`;
      logger.info('Sync race winner: %s', host);
      request.setVariable('PMUSER_SELECTED_ORIGIN', host);
      return;
    }

    // Sync race failed => fall through to random selection
    logger.warn('Sync race failed => using random fallback');
  } else {
    // ASYNC MODE: Random selection + background race
    logger.info('No cache => async mode (random + background race)');
  }

  // Random selection (either async mode or sync fallback)
  const rand = selectRandomOrigin(origins);
  const randHost = `${rand}${originDomain}`;
  logger.info('Using random origin: %s', randHost);
  request.setVariable('PMUSER_SELECTED_ORIGIN', randHost);

  // Start background race if not already running
  if (!raceInFlight) {
    raceInFlight = true;
    logger.debug('Starting background race');
    fireAndForgetRace(request, origins, now, raceTimeoutMs).finally(() => {
      raceInFlight = false;
    });
  }
}

/**
 * Load origin IDs from PMUSER_ORIGIN_1..N configuration variables
 * 
 * Reads contiguous indices starting from 1 until no variable is found.
 * 
 * @param {Request} request - EdgeWorkers request object
 * @returns {string[]} Array of origin IDs (e.g., ['origin1','origin2'])
 */
function loadOriginsFromConfig(request) {
  const out = [];
  let i = 1;
  while (true) {
    const origin = request.getVariable(`PMUSER_ORIGIN_${i}`);
    if (!origin) break;
    out.push(origin);
    i++;
  }
  logger.debug('Loaded origins=%d', out.length);
  return out;
}

/**
 * Choose a random origin from the provided list
 * 
 * Uses Math.random() to select an origin for immediate origin requests when
 * no cached race result is available.
 * 
 * @param {string[]} origins - Array of available origin IDs
 * @returns {string} Selected origin ID
 */
function selectRandomOrigin(origins) {
  const idx = Math.floor(Math.random() * origins.length);
  const sel = origins[idx];
  logger.debug('Random origin %d/%d: %s', idx + 1, origins.length, sel);
  return sel;
}

/**
 * Start a background race operation (non-blocking)
 * 
 * Initiates origin racing in the background and updates the global cache
 * on success. Uses fire-and-forget pattern to avoid blocking client request processing.
 * 
 * @param {Request} request - EdgeWorkers request object
 * @param {string[]} origins - Array of origin IDs to race
 * @param {number} timestamp - Frozen Date.now() captured at handler start
 * @param {number} raceTimeoutMs - Per-origin timeout in milliseconds
 * @returns {Promise<void>}
 */
function fireAndForgetRace(request, origins, timestamp, raceTimeoutMs) {
  logger.debug('BG race start: timeout=%dms origins=%d', raceTimeoutMs, origins.length);
  return raceOrigins(request, origins, raceTimeoutMs)
    .then((winner) => {
      if (winner) {
        logger.info('BG race winner=%s', winner);
        fastestOrigin = winner;
        lastMeasurement = timestamp; // keep frozen-start semantics
      } else {
        logger.warn('BG race no winner');
      }
    })
    .catch((err) => {
      logger.error('BG race error: %s', err.message);
    });
}

/**
 * Race all origins in parallel and return the fastest responder
 * 
 * Sends simultaneous HTTP requests to all configured origins using the specified
 * proxy domain and method. Uses Promise.any() to return the first successful response.
 * Includes comprehensive logging of URLs and results for monitoring.
 * 
 * @param {Request} request - EdgeWorkers request object
 * @param {string[]} origins - Array of origin IDs to race
 * @param {number} timeoutMs - Per-origin timeout in milliseconds
 * @returns {Promise<string|null>} Winner origin ID or null if all failed
 */
async function raceOrigins(request, origins, timeoutMs) {
  if (!origins.length) {
    logger.warn('Race aborted: no origins');
    return null;
  }

  const proxyDomain = request.getVariable('PMUSER_PROXY_DOMAIN');
  if (!proxyDomain) {
    logger.error('Race aborted: PMUSER_PROXY_DOMAIN not set');
    return null;
  }
  
  // Get custom race URL or fallback to incoming request URL
  const raceUrl = request.getVariable('PMUSER_RACE_URL');
  const reqPath = raceUrl || request.url || '/';
  
  // Get custom race method or fallback to HEAD
  const raceMethod = request.getVariable('PMUSER_RACE_METHOD') || DEFAULT_RACE_METHOD;
  let normalizedMethod = raceMethod.toUpperCase();
  
  // Validate method
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    logger.warn('Invalid PMUSER_RACE_METHOD=%s, using HEAD', raceMethod);
    normalizedMethod = 'HEAD';
  }
  
  logger.debug('Race begin: origins=%d proxy=%s path=%s method=%s timeout=%dms', 
    origins.length, proxyDomain, reqPath, normalizedMethod, timeoutMs);

  const probes = origins.map(async (origin, i) => {
    const url = `https://${origin}${proxyDomain}${reqPath}`;
    logger.debug('Probe[%d]: %s %s timeout=%dms', i + 1, normalizedMethod, url, timeoutMs);

    try {
      const res = await httpRequest(url, { method: normalizedMethod, timeout: timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.debug('%s OK %d', origin, res.status);
      return origin;
    } catch (err) {
      logger.debug('%s failed: %s', origin, err.message);
      throw err;
    }
  });

  try {
    const winner = await Promise.any(probes);
    logger.info('Race winner=%s', winner);
    return winner;
  } catch {
    logger.warn('Race failed (all origins)');
    return null;
  }
}
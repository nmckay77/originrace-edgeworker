# OriginRace EdgeWorker

Automatically route traffic to your fastest origin server

## What is OriginRace?

OriginRace dynamically determines the fastest origin server from each Akamai edge server's perspective by racing multiple origins in parallel. Unlike path optimization (SureRoute), OriginRace selects the **best origin** rather than the best path to a single origin.

### Key Difference from SureRoute
- **SureRoute**: Finds the best network path to a specific origin
- **OriginRace**: Finds the best origin from multiple options

## How It Works

### Origin Names
Define your origins using `PMUSER_ORIGIN_1`, `PMUSER_ORIGIN_2`, etc. These can be any descriptive names like `dc1`, `us-east`, `primary`, etc but must map to actual origin hostnames.

### Hostname Construction

**Racing Hostnames** (for performance testing):

- Pattern: `{origin_name}{PMUSER_PROXY_DOMAIN}`
- Example: `origin1.proxy.example.com`
- Used to test origin performance from the edge

**Origin Hostnames** (for actual traffic):

- Pattern: `{origin_name}{PMUSER_ORIGIN_DOMAIN}`
- Example: `origin1.example.com`
- Used by Property Manager for going to origin

### Race Algorithm
- **Parallel probes**: Simultaneous HTTP requests to all racing hostnames
- **First success wins**: Uses `Promise.any()` - only one origin needs to respond with 2xx
- **Failure handling**: If all origins fail, falls back to random selection

## Cache and Mode Behavior

The EdgeWorker caches the race winner in memory with a configurable TTL. There are two main paths:

### Fast Path: Use Cached Result
When a usable cached winner exists, the EdgeWorker responds immediately:
- **Fresh cache**: Cache age within TTL
- **Stale cache allowed**: Cache expired but `PMUSER_USE_STALE_RACE_CACHE=true`

If the cache is approaching expiration (past the refresh threshold), a background race starts to update the cache for future requests.

### Slow Path: Select New Origin  
When no usable cache exists, the EdgeWorker must select an origin:
- **No cache**: Cold start with no previous results
- **Stale cache not allowed**: Cache expired and `PMUSER_USE_STALE_RACE_CACHE=false`

**Sync Mode (Default)**: Wait for race to complete, respond with race winner (or random if race fails)

**Async Mode**: Respond immediately with random origin, start background race for future requests

### Decision Flow
```javascript
if (cached_winner_exists) {
    if (cache_is_fresh || stale_cache_allowed) {
        use_cached_winner()
        if (past_refresh_threshold) {
            start_background_race()  // Always async
        }
        return
    }
}

// No usable cache - sync/async mode applies
if (sync_mode) {
    winner = await race_origins()
    use_winner_or_random_fallback(winner)
} else {
    use_random_origin()
    start_background_race()  // For future requests
}
```

## Configuration

### Required PMUSER Variables
| Variable | Description | Example |
|----------|-------------|---------|
| `PMUSER_ORIGIN_1..N` | Origin names (sequential, starting from 1) | `origin1`, `origin2`, `origin3` |
| `PMUSER_PROXY_DOMAIN` | Domain suffix for racing | `.proxy.example.com` |
| `PMUSER_ORIGIN_DOMAIN` | Domain suffix for origin selection | `.example.com` |

### Optional PMUSER Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `PMUSER_RACE_CACHE_MINUTES` | Cache TTL in minutes | `3` |
| `PMUSER_USE_STALE_RACE_CACHE` | Use expired cache while refreshing | `true` |
| `PMUSER_RACE_TIMEOUT_MS` | Per-origin probe timeout in milliseconds | `500` |
| `PMUSER_RACE_CACHE_REFRESH_THRESHOLD` | Refresh threshold (0.0-1.0) | `0.8` |
| `PMUSER_SYNC_ON_COLD` | Wait for race when cache unavailable | `true` |
| `PMUSER_RACE_URL` | Custom URL path for racing | incoming request URL |
| `PMUSER_RACE_METHOD` | HTTP method for racing (GET\|HEAD) | `HEAD` |

### Output Variable
| Variable | Description |
|----------|-------------|
| `PMUSER_SELECTED_ORIGIN` | Selected origin hostname for Property Manager |

## Setup

### 1. Create Proxy Properties
Since EdgeWorkers can only make sub-requests to Akamaized properties, you need to create proxy properties for racing. The easiest way to achieve this is by adding a wildcard proxy hostname to your property like e.g. `*.proxy.example.com` and property hostname matches for each proxy property hostname that then maps to the actual origin. It is also recommended to set the proxy hostname matches to match on Request Type being EW_SUBREQUEST to ensure that only the EdgeWorker sub-requests are allowed to use the proxy property hostnames.

- `origin1.proxy.example.com` → forwards to `origin1.example.com`
- `origin2.proxy.example.com` → forwards to `origin2.example.com`

Or in XML metadata:

```xml
<match:hoit result="true" host="dc1.proxy.example.com">
    <match:request.type value="EW_SUBREQUEST" result="true">
        <forward:origin-server>
            <host>dc1.example.com</host>
        </forward:origin-server>
    </match:request.type>
</match:hoit>
```

### 2. Define PMUSER Variables in Property Manager
Create the **required variables** and set their values in your property configuration. The EdgeWorker code has default settings for all optional variables, those do not need to be set in Property Manager unless you wish to override the defaults.

### 3. Deploy EdgeWorker code
Create a new EdgeWorkers and upload the code bundle (main.js and bundle.json). See [EdgeWorker documentation](https://techdocs.akamai.com/edgeworkers/docs/welcome-to-edgeworkers) for details.

### 4. Add EdgeWorker and Origin in Property Manager
Add the EdgeWorker behavior to your Property Manager configuration **before** the Origin behavior and in the Origin behavior use `PMUSER_SELECTED_ORIGIN` variable as the Origin Server Hostname. The EdgeWorker will set the  `PMUSER_SELECTED_ORIGIN` based on what origin it selected from races or cached race results.

## Use Cases

- **Multi-region origins**: Automatically select the fastest origin based on current network conditions
- **Active-active failover**: Continuously verify origin performance and switch when needed
- **Geographic diversity**: Serve from the fastest origin regardless of static geographic mapping
- **Dynamic load distribution**: Naturally balance load based on actual origin performance

## Performance Considerations

- **Cache TTL**: Longer TTL reduces racing overhead but may use suboptimal origins longer
- **Refresh threshold**: Lower threshold (e.g., 0.5) refreshes cache earlier for fresher data
- **Timeout**: Lower timeout (e.g., 200ms) responds faster but may miss slower origins
- **Sync vs Async**: Sync mode ensures optimal selection but adds latency on cold starts

## Monitoring

The EdgeWorker provides detailed logging:
- Origin selection decisions
- Race results and timing
- Cache hit/miss status
- Background refresh operations
- Error conditions

Enable EdgeWorker debugging to view logs in response headers.

## References

- EdgeWorker documentation can be found [here](https://techdocs.akamai.com/edgeworkers/docs/welcome-to-edgeworkers)
- Property Manager documentation can be found [here](https://techdocs.akamai.com/property-mgr/docs/welcome-prop-manager)

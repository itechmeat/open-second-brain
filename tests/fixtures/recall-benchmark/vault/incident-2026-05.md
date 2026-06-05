# Outage postmortem

Root cause: a connection-pool timeout cascaded into worker starvation during
the deploy. Action items: tighter timeouts, circuit breaker, alert on queue depth.

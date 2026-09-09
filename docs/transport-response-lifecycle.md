# Incomplete Source responses

Enrollment JSON, revision metadata, blob downloads, and the doctor source probe
listen to both request and response-stream failures. A response is accepted only after the complete
HTTP message reaches `end`. Errors and premature `close` settle the operation
and destroy its request, including when the socket has already closed and its
idle timeout can no longer fire.

Truncated enrollment JSON reports the existing EnrollmentTransportError.
Truncated transport responses report TransportInterruptedError. A truncated
doctor probe response reports the transport probe failure instead of stalling
until the probe timeout. Size limits,
TLS/signing pins, authorization, metadata verification, blob digests, and atomic
cache publication remain unchanged. Incomplete bytes never reach the verified
cache writer.

The regression tests use an isolated pinned loopback HTTPS server, deliberately
truncate JSON/metadata/blob responses, and verify successful retry and subsequent
cache reuse. No real credentials or remote service are used.

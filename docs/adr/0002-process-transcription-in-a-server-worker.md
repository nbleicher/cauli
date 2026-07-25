# Process Transcription in a Server Worker

Cauli performs transcription in a persistent server-side worker using OpenRouter rather than inside the browser extension. This adds server infrastructure, but keeps provider credentials out of the client, allows processing to survive Chrome closing, and provides a reliable place to split Source Audio into bounded chunks, process chunks concurrently, retry failures, and merge results in order.

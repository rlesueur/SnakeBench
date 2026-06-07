# Launch the local llama.cpp (turboquant) server for SnakeBench's LLM agent.
# Text-only: the benchmark no longer uses the board image, so the vision
# projector (mmproj) is not loaded — this frees VRAM for the 35B weights. Paths
# can be overridden via parameters or the matching environment variables.
param(
  [string]$Bin    = $(if ($env:LLAMA_BIN)    { $env:LLAMA_BIN }    else { "C:\Users\robyn\llama-cpp-turboquant\build\bin\llama-server.exe" }),
  [string]$Model  = $(if ($env:LLAMA_MODEL_PATH) { $env:LLAMA_MODEL_PATH } else { "C:\Users\robyn\models\llama-cpp-gguf\Qwen3.6-35B-A3B-UD-Q6_K.gguf" }),
  [int]$Port      = $(if ($env:LLAMA_PORT)   { [int]$env:LLAMA_PORT } else { 8081 }),
  [int]$Ctx       = $(if ($env:LLAMA_CTX)    { [int]$env:LLAMA_CTX }  else { 32768 })
)

if (-not (Test-Path $Bin))   { throw "llama-server not found: $Bin" }
if (-not (Test-Path $Model)) { throw "model not found: $Model" }

Write-Host "Starting llama-server (text-only) on port $Port"
Write-Host "  model           : $Model"
# Reasoning is left unrestricted — the benchmark is about the model reasoning
# through novel laws, so we do not cap chain-of-thought.
& $Bin -m $Model --host 127.0.0.1 --port $Port -c $Ctx -ngl 999 --jinja

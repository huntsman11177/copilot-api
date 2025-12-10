import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { state } from "./lib/state"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(logger())
server.use(cors())

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

const upstreamHeaders = (token: string, acceptHeader?: string | null) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.96.0",
  "User-Agent": "GitHubCopilot/1.168.0",
  Accept: acceptHeader ?? "application/json",
})

const normalizeMessagesToInput = (
  parsed: Record<string, unknown>,
): string | undefined => {
  if ("input" in parsed) return undefined
  if (!("messages" in parsed)) return undefined

  const messages = (
    parsed.messages as Array<Record<string, unknown>> | undefined
  )
    ?.map((msg) => {
      const role = (msg.role as string | undefined) ?? "user"
      const content = msg.content
      if (typeof content === "string") {
        return {
          type: "message",
          role,
          content: [{ type: "input_text", text: content }],
        }
      }
      if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            if (typeof part === "string") return part
            if (typeof part === "object" && part !== null && "text" in part) {
              const maybeText = (part as { text?: unknown }).text
              return typeof maybeText === "string" ? maybeText : ""
            }
            return ""
          })
          .join("")
        return {
          type: "message",
          role,
          content: [{ type: "input_text", text }],
        }
      }
      return {
        type: "message",
        role,
        content: [{ type: "input_text", text: "" }],
      }
    })
    .filter(Boolean)

  return JSON.stringify({
    model: parsed.model ?? parsed.selected_model ?? "gpt-4o",
    input: messages,
    stream: parsed.stream ?? false,
    reasoning: parsed.reasoning,
    temperature: parsed.temperature,
    max_output_tokens: parsed.max_tokens ?? parsed.max_output_tokens,
  })
}

const handleResponses = async (c: Context) => {
  const bearer = c.req.header("authorization") ?? ""
  const token = bearer.replace(/Bearer\s+/i, "").trim()
  const actualToken =
    token === "dummy" || token === "" ? state.copilotToken : token

  if (!actualToken) {
    return c.json({ error: "Missing Copilot token" }, 401)
  }

  try {
    const upstreamUrl = "https://api.githubcopilot.com/v1/responses"

    const rawBody = await c.req.text()
    let bodyToSend = rawBody

    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>
      const normalized = normalizeMessagesToInput(parsed)
      if (normalized) bodyToSend = normalized
    } catch {
      // fall back to raw body
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(actualToken, c.req.header("accept")),
      body: bodyToSend,
    })

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text()
      console.error("Upstream Error:", errorText)
      return c.body(errorText, upstreamResponse.status)
    }

    const contentType = upstreamResponse.headers.get("content-type")
    if (contentType) c.header("content-type", contentType)

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
    })
  } catch (error) {
    console.error("Proxy Error:", error)
    return c.json({ error: "Failed to proxy request to /v1/responses" }, 500)
  }
}

server.post("/v1/responses", handleResponses)
server.post("/v1/responses/*", handleResponses)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)

server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

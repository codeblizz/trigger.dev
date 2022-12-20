import { v4 } from "uuid";
import { z } from "zod";
import { TimeoutError, HostConnection } from "./connection";
import { WebSocket } from "ws";
import {
  ZodRPC,
  ServerRPCSchema,
  HostRPCSchema,
  Logger,
} from "internal-bridge";
import * as pkg from "../package.json";
import { Trigger, TriggerOptions } from "./trigger";
import { TriggerContext } from "./types";
import { ContextLogger } from "./logger";

export class TriggerClient<TEventData = void> {
  #trigger: Trigger<TEventData>;
  #options: TriggerOptions<TEventData>;

  #connection?: HostConnection;
  #serverRPC?: ZodRPC<typeof ServerRPCSchema, typeof HostRPCSchema>;

  #apiKey: string;
  #endpoint: string;

  #isConnected = false;
  #retryIntervalMs: number = 3000;
  #logger: Logger;

  constructor(
    trigger: Trigger<TEventData>,
    options: TriggerOptions<TEventData>
  ) {
    this.#trigger = trigger;
    this.#options = options;

    const apiKey = this.#options.apiKey ?? process.env.TRIGGER_API_KEY;

    if (!apiKey) {
      throw new Error(
        "Cannot connect to Trigger because of invalid API Key: Please include an API Key in the `apiKey` option or in the `TRIGGER_API_KEY` environment variable."
      );
    }

    this.#apiKey = apiKey;
    this.#endpoint = this.#options.endpoint ?? "ws://trigger.dev/ws";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel ?? "info");
  }

  async listen(instanceId?: string) {
    await this.#initializeConnection(instanceId);
    this.#initializeRPC();
    this.#initializeHost();
  }

  async #initializeConnection(instanceId?: string) {
    const id = instanceId ?? v4();

    this.#logger.debug("Initializing connection...", id);

    const headers = { Authorization: `Bearer ${this.#apiKey}` };

    const connection = new HostConnection(
      new WebSocket(this.#endpoint, {
        headers,
        followRedirects: true,
      }),
      { id }
    );

    connection.onClose.attach(async ([code, reason]) => {
      console.error(`Could not connect to trigger.dev (code ${code})`);

      if (reason) {
        console.error(reason);
      }
    });

    await connection.connect();

    this.#logger.debug("Connection initialized", id);

    this.#connection = connection;
    this.#isConnected = true;
  }

  async #initializeRPC() {
    if (!this.#connection) {
      throw new Error("Cannot initialize RPC without a connection");
    }

    const serverRPC = new ZodRPC({
      connection: this.#connection,
      sender: ServerRPCSchema,
      receiver: HostRPCSchema,
      handlers: {
        TRIGGER_WORKFLOW: async (data) => {
          console.log("TRIGGER_WORKFLOW", data);

          const ctx: TriggerContext = {
            id: data.id,
            environment: data.meta.environment,
            apiKey: data.meta.apiKey,
            organizationId: data.meta.organizationId,
            logger: new ContextLogger(async (level, message, properties) => {
              await serverRPC.send("SEND_LOG", {
                id: data.id,
                log: {
                  level,
                  message,
                  properties: JSON.stringify(properties ?? {}),
                },
              });
            }),
            fireEvent: async (event) => {
              await serverRPC.send("SEND_EVENT", {
                id: data.id,
                event: JSON.parse(JSON.stringify(event)),
              });
            },
          };

          // TODO: handle this better
          this.#trigger.options
            .run(data.trigger.input as TEventData, ctx)
            .then((output) => {
              return serverRPC.send("COMPLETE_WORKFLOW_RUN", {
                id: data.id,
                output: JSON.stringify(output),
                workflowId: data.meta.workflowId,
              });
            })
            .catch((anyError) => {
              const parseAnyError = (
                error: any
              ): {
                name: string;
                message: string;
                stackTrace?: string;
              } => {
                if (error instanceof Error) {
                  return {
                    name: error.name,
                    message: error.message,
                    stackTrace: error.stack,
                  };
                }

                return {
                  name: "UnknownError",
                  message: "An unknown error occurred",
                };
              };

              const error = parseAnyError(anyError);

              return serverRPC.send("SEND_WORKFLOW_ERROR", {
                id: data.id,
                workflowId: data.meta.workflowId,
                error,
              });
            });
        },
      },
    });

    this.#serverRPC = serverRPC;
  }

  async #initializeHost() {
    if (!this.#connection) {
      throw new Error("Cannot initialize host without a connection");
    }

    if (!this.#serverRPC) {
      throw new Error("Cannot initialize host without an RPC connection");
    }

    const response = await this.#send("INITIALIZE_HOST", {
      apiKey: this.#apiKey,
      workflowId: this.#trigger.id,
      workflowName: this.#trigger.name,
      trigger: this.#trigger.on,
      packageVersion: pkg.version,
      packageName: pkg.name,
    });

    if (response?.type === "error") {
      throw new Error(response.message);
    }

    console.log("Host initialized");
  }

  async #send<MethodName extends keyof typeof ServerRPCSchema>(
    methodName: MethodName,
    request: z.input<typeof ServerRPCSchema[MethodName]["request"]>
  ) {
    if (!this.#serverRPC) throw new Error("serverRPC not initialized");

    while (true) {
      try {
        return await this.#serverRPC.send(methodName, request);
      } catch (err) {
        if (err instanceof TimeoutError) {
          console.log(
            `RPC call timed out, retrying in ${Math.round(
              this.#retryIntervalMs / 1000
            )}s...`
          );
          console.log(err);

          await sleep(this.#retryIntervalMs);
        } else {
          throw err;
        }
      }
    }
  }
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

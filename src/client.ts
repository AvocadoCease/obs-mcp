import WebSocket from 'ws';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const logger = {
  log: (message: string) => console.error(message),
  error: (message: string) => console.error(message),
  debug: (message: string) => console.error(message),
};

// Define OpCodes
enum OpCode {
  Hello = 0,
  Identify = 1,
  Identified = 2,
  Reidentify = 3,
  Event = 5,
  Request = 6,
  RequestResponse = 7,
  RequestBatch = 8,
  RequestBatchResponse = 9
}

// Define EventSubscription bitmasks
export enum EventSubscription {
  None = 0,
  General = 1 << 0,
  Config = 1 << 1,
  Scenes = 1 << 2,
  Inputs = 1 << 3,
  Transitions = 1 << 4,
  Filters = 1 << 5,
  Outputs = 1 << 6,
  SceneItems = 1 << 7,
  MediaInputs = 1 << 8,
  Vendors = 1 << 9,
  Ui = 1 << 10,
  All = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10)
}

// Define interfaces for message types
interface BaseMessage {
  op: OpCode;
  d: any;
}

interface HelloMessage extends BaseMessage {
  d: {
    obsStudioVersion: string;
    obsWebSocketVersion: string;
    rpcVersion: number;
    authentication?: {
      challenge: string;
      salt: string;
    };
  };
}

interface IdentifyMessage extends BaseMessage {
  d: {
    rpcVersion: number;
    authentication?: string;
    eventSubscriptions: number;
  };
}

interface IdentifiedMessage extends BaseMessage {
  d: {
    negotiatedRpcVersion: number;
  };
}

interface RequestMessage extends BaseMessage {
  d: {
    requestType: string;
    requestId: string;
    requestData?: any;
  };
}

interface RequestResponseMessage extends BaseMessage {
  d: {
    requestType: string;
    requestId: string;
    requestStatus: {
      result: boolean;
      code: number;
      comment?: string;
    };
    responseData?: any;
  };
}

interface EventMessage extends BaseMessage {
  d: {
    eventType: string;
    eventIntent: number;
    eventData?: any;
  };
}

// Close codes OBS WebSocket uses when it rejects a client
const CLOSE_CODE_HINTS: Record<number, string> = {
  4009: 'Authentication failed - check OBS_WEBSOCKET_PASSWORD matches Tools > WebSocket Server Settings in OBS.',
  4010: 'Unsupported RPC version - update OBS Studio to v28 or newer.',
};

const CONNECT_TIMEOUT_MS = 5000;

/**
 * Node reports a refused localhost connection as an AggregateError (IPv6 + IPv4 attempts) with an empty
 * message, so fall back to the error code or the inner errors to say what actually went wrong
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  const inner = error instanceof AggregateError ? error.errors.map((e) => describeError(e)).filter(Boolean) : [];
  return code || inner[0] || error.name;
}

// Define the OBS WebSocket client class
export class OBSWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private password: string | null;
  private connected: boolean = false;
  private identified: boolean = false;
  private connecting: Promise<void> | null = null;
  private pendingRequests: Map<string, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }> = new Map();

  constructor(url: string = 'ws://localhost:4455', password: string | null = null) {
    super();
    this.url = url;
    this.password = password;
  }

  /**
   * Connect to the OBS WebSocket server. Concurrent callers share the same in-flight attempt.
   */
  public async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.openConnection().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private openConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      logger.log(`Attempting to connect to OBS WebSocket at: ${this.url}`);

      let settled = false;
      let ws: WebSocket;

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        if (this.ws === ws) {
          this.resetConnection(error.message);
        }
        ws.terminate();
        reject(error);
      };

      const connectionTimeout = setTimeout(() => {
        fail(new Error('WebSocket connection timeout - OBS may not be running or WebSocket may be disabled'));
      }, CONNECT_TIMEOUT_MS);

      try {
        ws = new WebSocket(this.url);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to create WebSocket connection: ${errorMessage}`);
        settled = true;
        clearTimeout(connectionTimeout);
        reject(error);
        return;
      }
      this.ws = ws;

      ws.on('open', () => {
        this.connected = true;
        logger.log('WebSocket connection opened successfully');
      });

      ws.on('message', (data: WebSocket.Data) => {
        let message: BaseMessage;
        try {
          message = JSON.parse(data.toString()) as BaseMessage;
        } catch (error) {
          logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        if (message.op === OpCode.Hello) {
          try {
            this.identify(ws, (message as HelloMessage).d);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }

        if (message.op === OpCode.Identified) {
          this.identified = true;
          logger.log('Successfully identified with OBS WebSocket server');
          this.emit('identified', (message as IdentifiedMessage).d);
          succeed();
          return;
        }

        this.handleMessage(message);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = CLOSE_CODE_HINTS[code] || reason.toString() || 'No reason provided';
        logger.log(`WebSocket connection closed with code ${code}: ${reasonStr}`);

        if (!settled) {
          fail(new Error(`OBS closed the connection (${code}): ${reasonStr}`));
          return;
        }

        if (this.ws === ws) {
          const wasIdentified = this.identified;
          this.resetConnection(`WebSocket connection closed: ${reasonStr}`);
          if (wasIdentified) {
            this.emit('disconnected');
          }
        }
      });

      ws.on('error', (error) => {
        const errorMessage = describeError(error);
        logger.error(`WebSocket connection error: ${errorMessage}`);

        // Provide more specific error information
        if (errorMessage.includes('ECONNREFUSED')) {
          logger.error('Connection refused. Make sure OBS Studio is running and WebSocket is enabled.');
          logger.error('Check that the WebSocket port (default: 4455) is not blocked by firewall.');
        } else if (errorMessage.includes('ENOTFOUND')) {
          logger.error('Host not found. Check the OBS_WEBSOCKET_URL environment variable.');
        } else if (errorMessage.includes('ETIMEDOUT')) {
          logger.error('Connection timed out. Check network connectivity and firewall settings.');
        }

        const hint = errorMessage.includes('ECONNREFUSED')
          ? ' - OBS is not running or its WebSocket server is off (Tools > WebSocket Server Settings)'
          : '';
        fail(new Error(`${errorMessage}${hint}`));
      });
    });
  }

  /**
   * Clear connection state and reject any requests still waiting on a response
   */
  private resetConnection(reason: string): void {
    this.ws = null;
    this.connected = false;
    this.identified = false;
    this.pendingRequests.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    });
    this.pendingRequests.clear();
  }

  /**
   * Check if the client is connected and identified
   */
  public isConnected(): boolean {
    return this.connected && this.identified;
  }

  /**
   * Get connection status information
   */
  public getConnectionStatus(): {
    connected: boolean;
    identified: boolean;
    url: string;
    hasPassword: boolean;
  } {
    return {
      connected: this.connected,
      identified: this.identified,
      url: this.url,
      hasPassword: this.password !== null
    };
  }

  /**
   * Disconnect from the OBS WebSocket server
   */
  public disconnect(): void {
    const ws = this.ws;
    if (ws) {
      this.resetConnection('Disconnected from OBS WebSocket server');
      ws.close();
    }
  }

  /**
   * Send a request to the OBS WebSocket server, connecting first if OBS has come up since the last attempt
   */
  public async sendRequest<T = any>(requestType: string, requestData?: any, timeout: number = 10000): Promise<T> {
    if (!this.isConnected()) {
      try {
        await this.connect();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Not connected to OBS WebSocket server (${errorMessage})`);
      }
    }

    const ws = this.ws;
    if (!ws) {
      throw new Error('Not connected or identified with OBS WebSocket server');
    }

    return new Promise<T>((resolve, reject) => {
      const requestId = crypto.randomUUID();

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestType} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: (data: T) => {
          clearTimeout(timeoutId);
          resolve(data);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        timeout: timeoutId
      });

      const requestMessage: RequestMessage = {
        op: OpCode.Request,
        d: {
          requestType,
          requestId,
          requestData
        }
      };

      ws.send(JSON.stringify(requestMessage));
    });
  }

  /**
   * Handle incoming messages from the OBS WebSocket server
   */
  private handleMessage(message: BaseMessage): void {
    switch (message.op) {
      case OpCode.RequestResponse:
        this.handleRequestResponse(message as RequestResponseMessage);
        break;

      case OpCode.Event:
        this.handleEvent(message as EventMessage);
        break;

      default:
        logger.debug(`Unhandled message type: ${message.op}`);
        break;
    }
  }

  /**
   * Handle request responses from the OBS WebSocket server
   */
  private handleRequestResponse(message: RequestResponseMessage): void {
    const { requestId, requestStatus, responseData } = message.d;
    const pendingRequest = this.pendingRequests.get(requestId);

    if (pendingRequest) {
      this.pendingRequests.delete(requestId);

      if (requestStatus.result) {
        pendingRequest.resolve(responseData || {});
      } else {
        const errorMessage = `Request failed: ${requestStatus.code} ${requestStatus.comment || ''}`;
        pendingRequest.reject(new Error(errorMessage));
      }
    }
  }

  /**
   * Handle events from the OBS WebSocket server
   */
  private handleEvent(message: EventMessage): void {
    const { eventType, eventData } = message.d;
    this.emit('event', eventType, eventData);
    this.emit(eventType, eventData);
  }

  /**
   * Answer the server's Hello with an Identify message. The Identified reply is handled in openConnection.
   */
  private identify(ws: WebSocket, hello: HelloMessage['d']): void {
    logger.log(`Received hello from OBS WebSocket v${hello.obsWebSocketVersion} (OBS v${hello.obsStudioVersion})`);
    logger.log(`RPC Version: ${hello.rpcVersion}`);

    let authentication: string | undefined;

    // Handle authentication if required
    if (hello.authentication && this.password) {
      logger.log('Authentication required, generating auth string...');
      authentication = this.generateAuthenticationString(
        this.password,
        hello.authentication.salt,
        hello.authentication.challenge
      );
    } else if (hello.authentication && !this.password) {
      const errorMsg = 'Password required for authentication but not provided. Set OBS_WEBSOCKET_PASSWORD environment variable.';
      logger.error(errorMsg);
      throw new Error(errorMsg);
    } else if (!hello.authentication) {
      logger.log('No authentication required');
    }

    const identifyMessage: IdentifyMessage = {
      op: OpCode.Identify,
      d: {
        rpcVersion: hello.rpcVersion,
        eventSubscriptions: EventSubscription.All,
      }
    };

    if (authentication) {
      identifyMessage.d.authentication = authentication;
    }

    logger.log('Sending identify message...');
    ws.send(JSON.stringify(identifyMessage));
  }

  /**
   * Generate authentication string for OBS WebSocket
   */
  private generateAuthenticationString(password: string, salt: string, challenge: string): string {
    // Create SHA256 Base64 encoded secret
    const secretBytes = crypto.createHash('sha256')
      .update(password + salt)
      .digest();
    const secret = secretBytes.toString('base64');

    // Create authentication string
    const authBytes = crypto.createHash('sha256')
      .update(secret + challenge)
      .digest();
    const authentication = authBytes.toString('base64');

    return authentication;
  }
}

export default OBSWebSocketClient;

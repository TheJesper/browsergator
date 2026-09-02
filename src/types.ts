export interface AgentContext {
  agentId: string;
  taskId: string;
  leaseOwnerId: string;
  clientSessionId: string;
  correlationId?: string;
}

export interface DriverTab {
  pageId: string;
  browserContextId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
}

export interface BrowserVersion {
  browser: string;
  protocolVersion: string;
  userAgent?: string;
}

export interface BrowserConnectionStatus {
  connected: boolean;
  browserSessionId?: string;
  reconnectAttempts: number;
  connectedAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
  version?: BrowserVersion;
}

export interface BrowserEvent {
  timestamp: string;
  kind: 'console' | 'network' | 'lifecycle';
  method: string;
  pageId?: string;
  data: Record<string, unknown>;
}

export interface AccessibilitySnapshot {
  pageId: string;
  nodes: Array<Record<string, unknown>>;
  truncated: boolean;
}

export interface ScreenshotResult {
  pageId: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: string;
}

export interface EvaluateResult {
  pageId: string;
  value: unknown;
}

export interface StorageResult {
  pageId: string;
  local: Record<string, string>;
  session: Record<string, string>;
  cookies: string;
}

export interface NavigationOptions {
  waitUntil: 'none' | 'domcontentloaded' | 'load' | 'networkidle';
  timeoutMs: number;
}

export interface NavigationResult {
  pageId: string;
  url: string;
  title: string;
}

export interface ElementLocator {
  uid?: string;
  selector?: string;
  text?: string;
  exactText?: boolean;
}

export interface InteractionResult {
  pageId: string;
  action: 'click' | 'fill' | 'hover' | 'drag';
  tagName: string;
  text: string;
}

export interface WaitForOptions {
  selector?: string;
  text?: string;
  timeoutMs: number;
}

export interface WaitResult {
  pageId: string;
  matched: 'selector' | 'text';
  value: string;
}

export interface ResponseBodyResult {
  body: string;
  base64Encoded: boolean;
}

export interface BrowserDriver {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): BrowserConnectionStatus;
  listTabs(): Promise<DriverTab[]>;
  openTab(url: string): Promise<DriverTab>;
  closeTab(pageId: string): Promise<void>;
  navigate(pageId: string, url: string, options: NavigationOptions): Promise<NavigationResult>;
  click(pageId: string, locator: ElementLocator): Promise<InteractionResult>;
  fill(pageId: string, locator: ElementLocator, value: string): Promise<InteractionResult>;
  waitFor(pageId: string, options: WaitForOptions): Promise<WaitResult>;
  pressKey(pageId: string, key: string): Promise<{ pageId: string; key: string }>;
  typeText(pageId: string, text: string): Promise<{ pageId: string; textLength: number }>;
  hover(pageId: string, locator: ElementLocator): Promise<InteractionResult>;
  clickAt(pageId: string, x: number, y: number): Promise<{ pageId: string; x: number; y: number }>;
  drag(pageId: string, from: ElementLocator, to: ElementLocator): Promise<InteractionResult>;
  handleDialog(pageId: string, accept: boolean, promptText?: string): Promise<{ pageId: string; accepted: boolean }>;
  snapshot(pageId: string, maxNodes: number): Promise<AccessibilitySnapshot>;
  screenshot(pageId: string, format: 'png' | 'jpeg', quality?: number): Promise<ScreenshotResult>;
  getResponseBody(pageId: string, requestId: string): Promise<ResponseBodyResult>;
  inspectPage(pageId: string): Promise<{ url: string; title: string }>;
  evaluate(pageId: string, expression: string): Promise<unknown>;
  readStorage(pageId: string): Promise<{ local: Record<string, string>; session: Record<string, string>; cookies: string }>;
  onEvent(listener: (event: BrowserEvent) => void): () => void;
}

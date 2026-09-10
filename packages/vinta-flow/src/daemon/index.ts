/** Public surface of the daemon unit: the server, its ports, and the wire contract. */
export { createToken, isLoopback, presentedToken, tokenMatches, TOKEN_QUERY } from './auth.ts'
export {
  runControl,
  UnsupportedOperation,
  type CapacityView,
  type DaemonRun,
  type PoolView,
  type RunControl,
} from './control.ts'
export { createApi, type ApiOptions } from './api.ts'
export { harnessCapabilities } from './harnesses.ts'
export { createStaticHandler, DEFAULT_UI_DIR, type StaticHandler } from './static.ts'
export { EventStream, DEFAULT_POLL_MS } from './stream.ts'
export {
  createWorkflowStore,
  isWorkflowId,
  plansDirFor,
  PLANS_DIRNAME,
  WORKFLOW_SUFFIX,
  type WorkflowRead,
  type WorkflowStore,
} from './workflows.ts'
export { startDaemon, type Daemon, type DaemonOptions } from './server.ts'
export {
  AddContextRequestSchema,
  AmendResponseSchema,
  AnswerRequestSchema,
  ErrorResponseSchema,
  EventFrameSchema,
  FrameSchema,
  GateQueueSchema,
  HarnessCapabilitiesSchema,
  HarnessStateSchema,
  HumanQuestionSchema,
  IssueSchema,
  NoArgsRequestSchema,
  NodeDetailSchema,
  NodeSummarySchema,
  OkResponseSchema,
  RedirectRequestSchema,
  ResourceStateSchema,
  RunEdgeSchema,
  RunListResponseSchema,
  RunSnapshotSchema,
  RunSummarySchema,
  SaveWorkflowRequestSchema,
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  formatPath,
  toWireIssues,
  type AmendResponse,
  type EventFrame,
  type Frame,
  type HumanQuestion,
  type Issue,
  type NodeDetail,
  type RunSnapshot,
  type RunSummary,
  type WorkflowListResponse,
  type WorkflowResponse,
} from './schemas.ts'

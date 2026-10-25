// What "run a routine" means, kept out of index.ts so it can be tested: open a
// chat for the routine's project and harness, then send its prompt. The timer
// claims the routine before calling this (routines-timer.ts), so a failure here
// is reported once, and the routine's next slot is its retry.
import type { Routine, WorkspaceInfo } from "../shared/protocol.js";
import type { Chat } from "./chats/chat.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessAdapter } from "./harness/types.js";

export async function runRoutine(routine: Routine, workspace: WorkspaceInfo, adapter: HarnessAdapter, manager: ChatManager): Promise<Chat> {
  const chat = await manager.create(adapter, workspace);
  await chat.send(routine.prompt, "normal");
  return chat;
}

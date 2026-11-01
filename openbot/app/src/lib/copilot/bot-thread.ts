export {
  type BotThread,
  botThreadKey,
  threadToUse,
} from "./bot-thread-state";
import { useBotThreadState } from "./bot-thread-state";

export function useBotThread(...input: Parameters<typeof useBotThreadState>) {
  return useBotThreadState(...input);
}

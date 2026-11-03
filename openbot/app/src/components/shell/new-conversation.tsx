import { createContext, useContext } from "react";

/** Opens the shell's existing blank-channel form. It does not submit or copy any messages. */
export const NewConversationContext = createContext<(() => void) | null>(null);
export const useNewConversation = () => useContext(NewConversationContext);

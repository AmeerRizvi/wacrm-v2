'use client';

import { createContext, useContext, type ReactNode } from 'react';

const ActiveConversationContext = createContext<string | null>(null);

export function ActiveConversationProvider({
  conversationId,
  children,
}: {
  conversationId: string | null;
  children: ReactNode;
}) {
  return (
    <ActiveConversationContext.Provider value={conversationId}>
      {children}
    </ActiveConversationContext.Provider>
  );
}

export function useActiveConversationId(): string | null {
  return useContext(ActiveConversationContext);
}

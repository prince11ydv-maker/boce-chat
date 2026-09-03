"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/PageHeader";

interface ChatMember {
  userId: string;
  user: { id: string; fullName: string; profile?: { avatarUrl?: string | null } | null };
}
interface ChatSummary {
  id: string;
  type: "DIRECT" | "GROUP" | "SELF";
  name?: string | null;
  members: ChatMember[];
  messages: { body?: string | null; type: string; createdAt: string }[];
}

export default function ChatsPage() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ chats: ChatSummary[] }>("/api/chats")
      .then((data) => setChats(data.chats))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load your chats."));
  }, []);

  return (
    <div className="grid h-screen grid-rows-[1fr] lg:grid-cols-[340px_1fr]">
      {/* Chat list */}
      <div className="flex flex-col border-r border-line">
        <div className="border-b border-line px-6 py-5">
          <h1 className="text-xl font-medium">Chats</h1>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="px-6 py-4 text-sm text-coral">{error}</p>}

          {chats === null && !error && (
            <p className="px-6 py-4 text-sm text-ink-soft">Loading your conversations…</p>
          )}

          {chats?.length === 0 && (
            <EmptyState icon="💬" title="No conversations yet" description="Message a friend to start a chat." />
          )}

          {chats?.map((chat) => {
            const other = chat.members.find((m) => m.user)?.user;
            const last = chat.messages[0];
            return (
              <button
                key={chat.id}
                onClick={() => setActiveId(chat.id)}
                className={`flex w-full items-center gap-3 px-6 py-3 text-left transition-colors hover:bg-ink/5 ${
                  activeId === chat.id ? "bg-cobalt-soft" : ""
                }`}
              >
                <Avatar name={chat.type === "SELF" ? "Saved" : other?.fullName ?? "Chat"} online={false} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {chat.type === "SELF" ? "Saved Messages" : chat.name ?? other?.fullName ?? "Direct chat"}
                  </p>
                  <p className="truncate text-xs text-ink-soft">
                    {last ? (last.type === "TEXT" ? last.body : `Sent a ${last.type.toLowerCase()}`) : "No messages yet"}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Conversation pane */}
      <div className="hidden lg:flex lg:flex-col lg:items-center lg:justify-center">
        <EmptyState
          icon="💬"
          title="Select a conversation"
          description="Pick a chat from the list, or start a new one from a friend's profile."
        />
      </div>
    </div>
  );
}

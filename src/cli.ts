#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  countConversations,
  getParticipants,
  getTranscript,
  listConversations,
  LISTEN_SPACE,
  LISTEN_SQL_DB,
  parseMetadata,
  transcriptToText,
  type Conversation,
} from "./listen.ts";
import { authStatus, type TcOptions } from "./tc.ts";

const USAGE = `feed — explore the Listen data source via the TinyCloud CLI

Usage:
  feed doctor                       Check tc session + access to the Listen space
  feed conversations [opts]         List conversations (newest first)
  feed transcript <id> [opts]       Print a conversation transcript
  feed pull [opts]                  Pull conversations + transcripts into a local cache
  feed stats                        Corpus summary

Global options:
  --profile <name>    tc profile to use      (env FEED_TC_PROFILE)
  --host <url>        node URL override       (env FEED_TC_HOST)
  --space <name>      space override         (env FEED_TC_SPACE, default ${LISTEN_SPACE})
  --json              machine-readable output

Command options:
  --limit <n>         conversations / pull: cap rows
  --source <s>        conversations / pull: filter by source (recorder, voice_memos, voxterm, ...)
  --out <dir>         pull: output directory (default ./.feed)

Reads (default app id xyz.tinycloud.listen, override with FEED_LISTEN_APP_ID):
  SQL  ${LISTEN_SQL_DB}
  KV   <app-id>/transcript/<conversationId>
`;

function tcOptions(values: Record<string, unknown>): TcOptions {
  return {
    profile: (values.profile as string) ?? process.env.FEED_TC_PROFILE,
    host: (values.host as string) ?? process.env.FEED_TC_HOST,
    space: (values.space as string) ?? process.env.FEED_TC_SPACE,
  };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printConversationLine(c: Conversation): void {
  const when = c.started_at ?? c.created_at ?? "";
  const dur = c.duration_secs != null ? `${Math.round(c.duration_secs)}s` : "?";
  const title = c.title?.trim() || "(untitled)";
  console.log(`${c.id}  ${when}  [${c.source}]  ${dur}  ${title}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      host: { type: "string" },
      space: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string" },
      source: { type: "string" },
      out: { type: "string" },
    },
  });

  const opts = tcOptions(values);
  const json = Boolean(values.json);
  const limit = values.limit ? Number(values.limit) : undefined;

  switch (command) {
    case "doctor": {
      let status: Record<string, unknown> | null = null;
      try {
        status = authStatus(opts);
      } catch (err) {
        fail(`tc auth status failed: ${(err as Error).message}`);
      }
      console.log("tc session:");
      console.log(`  profile:   ${status!.profile ?? "(active)"}`);
      console.log(`  host:      ${status!.host}`);
      console.log(`  did:       ${status!.did}`);
      console.log(`  spaceId:   ${status!.spaceId}`);
      console.log(`  authed:    ${status!.authenticated}`);
      try {
        const n = countConversations(opts);
        console.log(
          `\nListen access: OK — ${n} conversation(s) readable in ${LISTEN_SPACE}/sql/${LISTEN_SQL_DB}`,
        );
      } catch (err) {
        console.log(`\nListen access: NOT YET — ${(err as Error).message}`);
        console.log(
          `\nListen is a manifest app: its data lives in the "${LISTEN_SPACE}" space.\n` +
            `Grant read caps to this session (run as the owner of the Listen space):\n` +
            `  tc auth request --cap "tinycloud.sql:${LISTEN_SPACE}:xyz.tinycloud.listen/conversations:read" --grant --yes\n` +
            `  tc auth request --cap "tinycloud.kv:${LISTEN_SPACE}:xyz.tinycloud.listen:read" --grant --yes`,
        );
      }
      return;
    }

    case "conversations": {
      const rows = listConversations({ ...opts, limit, source: values.source as string | undefined });
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        if (rows.length === 0) console.log("(no conversations)");
        for (const c of rows) printConversationLine(c);
      }
      return;
    }

    case "transcript": {
      const id = positionals[0];
      if (!id) fail("usage: feed transcript <conversationId>");
      const transcript = getTranscript(id!, opts);
      if (json) {
        console.log(JSON.stringify(transcript, null, 2));
      } else if (transcript.length === 0) {
        console.log(`(no transcript for ${id})`);
      } else {
        console.log(transcriptToText(transcript));
      }
      return;
    }

    case "stats": {
      const rows = listConversations(opts);
      const bySource = new Map<string, number>();
      let totalSecs = 0;
      for (const c of rows) {
        bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
        if (typeof c.duration_secs === "number") totalSecs += c.duration_secs;
      }
      const summary = {
        conversations: rows.length,
        totalDurationMinutes: Math.round(totalSecs / 60),
        bySource: Object.fromEntries(bySource),
      };
      if (json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`conversations: ${summary.conversations}`);
        console.log(`total duration: ${summary.totalDurationMinutes} min`);
        console.log("by source:");
        for (const [src, n] of bySource) console.log(`  ${src}: ${n}`);
      }
      return;
    }

    case "pull": {
      const outDir = (values.out as string) ?? join(process.cwd(), ".feed");
      await mkdir(join(outDir, "transcripts"), { recursive: true });
      const rows = listConversations({ ...opts, limit, source: values.source as string | undefined });
      const index: Array<Record<string, unknown>> = [];
      let withTranscript = 0;

      for (const c of rows) {
        const participants = getParticipants(c.id, opts);
        const transcript = getTranscript(c.id, opts);
        if (transcript.length > 0) {
          withTranscript += 1;
          await Bun.write(
            join(outDir, "transcripts", `${c.id}.json`),
            JSON.stringify(transcript, null, 2),
          );
        }
        index.push({
          ...c,
          metadata: parseMetadata(c.metadata),
          participants,
          transcriptSentences: transcript.length,
          transcriptWords: transcript.reduce(
            (n, s) => n + (s.text?.trim().split(/\s+/).filter(Boolean).length ?? 0),
            0,
          ),
        });
        if (!json) console.log(`pulled ${c.id} (${transcript.length} sentences)`);
      }

      await Bun.write(join(outDir, "conversations.json"), JSON.stringify(index, null, 2));
      const result = {
        out: outDir,
        conversations: rows.length,
        withTranscript,
      };
      if (json) console.log(JSON.stringify(result, null, 2));
      else
        console.log(
          `\nwrote ${rows.length} conversations (${withTranscript} with transcripts) to ${outDir}`,
        );
      return;
    }

    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch((err) => fail((err as Error).message));

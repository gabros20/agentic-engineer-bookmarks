CREATE TABLE "invite_verify_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "invite_verify_attempts_ip_idx" ON "invite_verify_attempts" USING btree ("ip");
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"client_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_env" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"upstream_model" text NOT NULL,
	"display_name" text NOT NULL,
	"context_window" integer NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_name" text NOT NULL,
	"client_id" text NOT NULL,
	"model" text NOT NULL,
	"upstream_model" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"status_code" integer NOT NULL,
	"stream" integer NOT NULL,
	"duration_ms" integer,
	"usage_source" text NOT NULL,
	"error_kind" text,
	CONSTRAINT "usage_events_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_id" text NOT NULL,
	"subject" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_endpoint_id_model_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."model_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_adapter_subject_uq" ON "users" USING btree ("adapter_id","subject");
import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260813131728 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "fx_managed_price" ("id" text not null, "amount" numeric not null, "computed_at" timestamptz not null, "currency_code" text not null, "margin_multiplier" numeric not null, "nbp_rate" numeric not null, "price_id" text not null, "source_pln_amount" numeric not null, "variant_id" text not null, "raw_amount" jsonb not null, "raw_margin_multiplier" jsonb not null, "raw_nbp_rate" jsonb not null, "raw_source_pln_amount" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fx_managed_price_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fx_managed_price_variant_id" ON "fx_managed_price" ("variant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fx_managed_price_deleted_at" ON "fx_managed_price" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "fx_pricing_settings" ("id" text not null, "enabled" boolean not null default false, "last_run_at" timestamptz null, "last_run_summary" jsonb null, "margin_multiplier" numeric null, "staleness_tolerance_hours" integer null, "raw_margin_multiplier" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fx_pricing_settings_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fx_pricing_settings_deleted_at" ON "fx_pricing_settings" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "fx_managed_price" cascade;`);

    this.addSql(`drop table if exists "fx_pricing_settings" cascade;`);
  }

}

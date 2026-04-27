import * as React from "react";
import { useTranslation } from "react-i18next";

import type { AdminAlertChannel, AlertChannelType } from "@/api/adminAlerts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getUserErrorMessage } from "@/lib/userErrors";
import {
  type ChannelFormPayload,
  buildChannelPayload,
  canSubmitChannel,
  channelFormReducer,
  initChannelFormState,
} from "../lib/channelFormHelpers";

export function AlertChannelForm(props: {
  mode: "create" | "edit";
  channel?: AdminAlertChannel;
  pending: boolean;
  onSubmit: (v: ChannelFormPayload) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [state, dispatch] = React.useReducer(
    channelFormReducer,
    props.channel ?? null,
    initChannelFormState,
  );

  const valid = canSubmitChannel(state, props.mode);

  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        dispatch({ type: "set", patch: { error: null, errorField: null } });
        try {
          const result = buildChannelPayload(state, props.mode);
          if (!result.ok) {
            dispatch({
              type: "set",
              patch: { error: t(result.errorKey), errorField: result.field },
            });
            return;
          }
          await props.onSubmit(result.payload);
        } catch (err) {
          dispatch({
            type: "set",
            patch: {
              error: getUserErrorMessage(err, t, {
                action: props.mode === "edit" ? "update" : "create",
                fallback: t("settings.channelForm.requestFailed"),
              }),
              errorField: null,
            },
          });
        }
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label>{t("common.name")}</Label>
          <Input
            value={state.name}
            onChange={(e) => dispatch({ type: "set", patch: { name: e.target.value } })}
            disabled={props.pending}
          />
        </div>
        <div className="grid gap-2">
          <Label>{t("common.type")}</Label>
          <Select
            value={state.type}
            onValueChange={(v) =>
              // Sub-form changes with type; any pending validation error is now stale.
              dispatch({
                type: "set",
                patch: { type: v as AlertChannelType, error: null, errorField: null },
              })
            }
            disabled={props.mode === "edit"}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="webhook">webhook</SelectItem>
              <SelectItem value="telegram">telegram</SelectItem>
              <SelectItem value="email">email</SelectItem>
              <SelectItem value="serverchan3">serverchan3</SelectItem>
              <SelectItem value="serverchanturbo">serverchanturbo</SelectItem>
              <SelectItem value="bark">bark</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="text-sm">{t("common.enable")}</div>
        <Switch
          checked={state.enabled}
          onCheckedChange={(v) => dispatch({ type: "set", patch: { enabled: v } })}
          disabled={props.pending}
        />
      </div>

      {state.type !== "telegram" ? (
        <div className="grid gap-2">
          <Label>{t("settings.channelForm.messageTemplate")}</Label>
          <Textarea
            value={state.messageTemplate}
            onChange={(e) => dispatch({ type: "set", patch: { messageTemplate: e.target.value } })}
            disabled={props.pending}
            className="font-mono text-xs"
            rows={6}
            placeholder={t("settings.channelForm.templatePlaceholder")}
          />
        </div>
      ) : null}

      {state.type === "webhook" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("settings.channelForm.webhook.title")}</CardTitle>
            <CardDescription>{t("settings.channelForm.webhook.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.webhook.url")}</Label>
              <Input
                value={state.webhook.url}
                onChange={(e) => dispatch({ type: "webhook", patch: { url: e.target.value } })}
                disabled={props.pending}
                placeholder="https://example.com/webhook"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.webhook.method")}</Label>
                <Select
                  value={state.webhook.method}
                  onValueChange={(v) => dispatch({ type: "webhook", patch: { method: v } })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.webhook.timeoutMs")}</Label>
                <Input
                  value={state.webhook.timeoutMs}
                  onChange={(e) =>
                    dispatch({ type: "webhook", patch: { timeoutMs: e.target.value } })
                  }
                  disabled={props.pending}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.webhook.headersJson")}</Label>
              <Textarea
                value={state.webhook.headers}
                onChange={(e) => {
                  dispatch({ type: "webhook", patch: { headers: e.target.value } });
                  if (state.errorField === "webhookHeaders") {
                    dispatch({ type: "set", patch: { error: null, errorField: null } });
                  }
                }}
                disabled={props.pending}
                className="font-mono text-xs"
                aria-invalid={state.errorField === "webhookHeaders"}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.webhook.secret")}</Label>
              <Input
                value={state.webhook.secret}
                onChange={(e) => dispatch({ type: "webhook", patch: { secret: e.target.value } })}
                disabled={props.pending}
                placeholder={t("settings.channelForm.webhook.secretPlaceholder")}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.type === "telegram" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("settings.channelForm.telegram.title")}</CardTitle>
            <CardDescription>{t("settings.channelForm.telegram.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.telegram.chatId")}</Label>
              <Input
                value={state.telegram.chatId}
                onChange={(e) => dispatch({ type: "telegram", patch: { chatId: e.target.value } })}
                disabled={props.pending}
                placeholder="-100..."
              />
            </div>
            <div className="grid gap-2">
              <Label>
                {props.mode === "edit"
                  ? t("settings.channelForm.telegram.botTokenOptional")
                  : t("settings.channelForm.telegram.botToken")}
              </Label>
              <Input
                value={state.telegram.botToken}
                onChange={(e) =>
                  dispatch({ type: "telegram", patch: { botToken: e.target.value } })
                }
                disabled={props.pending}
                placeholder={
                  props.mode === "edit" ? t("settings.channelForm.telegram.keepPlaceholder") : ""
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.telegram.threadId")}</Label>
              <Input
                value={state.telegram.threadId}
                onChange={(e) =>
                  dispatch({ type: "telegram", patch: { threadId: e.target.value } })
                }
                disabled={props.pending}
                placeholder={t("settings.channelForm.telegram.threadIdPlaceholder")}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="text-sm">
                {t("settings.channelForm.telegram.disableNotification")}
              </div>
              <Switch
                checked={state.telegram.disableNotification}
                onCheckedChange={(v) =>
                  dispatch({ type: "telegram", patch: { disableNotification: v } })
                }
                disabled={props.pending}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.telegram.parseMode")}</Label>
              <Select
                value={state.telegram.parseMode}
                onValueChange={(v) => dispatch({ type: "telegram", patch: { parseMode: v } })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HTML">HTML</SelectItem>
                  <SelectItem value="MarkdownV2">MarkdownV2</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.telegram.messageTemplate")}</Label>
              <Textarea
                value={state.telegram.template}
                onChange={(e) =>
                  dispatch({ type: "telegram", patch: { template: e.target.value } })
                }
                disabled={props.pending}
                className="font-mono text-xs"
                rows={6}
                placeholder={t("settings.channelForm.telegram.templatePlaceholder")}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.telegram.buttons")}</Label>
              {state.telegram.buttons.map((btn, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={btn.text}
                    onChange={(e) => {
                      const next = [...state.telegram.buttons];
                      next[i] = { ...next[i]!, text: e.target.value };
                      dispatch({ type: "telegram", patch: { buttons: next } });
                    }}
                    disabled={props.pending}
                    placeholder={t("settings.channelForm.telegram.buttonText")}
                    className="flex-1"
                  />
                  <Input
                    value={btn.url}
                    onChange={(e) => {
                      const next = [...state.telegram.buttons];
                      next[i] = { ...next[i]!, url: e.target.value };
                      dispatch({ type: "telegram", patch: { buttons: next } });
                    }}
                    disabled={props.pending}
                    placeholder={t("settings.channelForm.telegram.buttonUrl")}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      dispatch({
                        type: "telegram",
                        patch: { buttons: state.telegram.buttons.filter((_, j) => j !== i) },
                      })
                    }
                    disabled={props.pending}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              ))}
              {state.telegram.buttons.length < 2 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    dispatch({
                      type: "telegram",
                      patch: { buttons: [...state.telegram.buttons, { text: "", url: "" }] },
                    })
                  }
                  disabled={props.pending}
                >
                  {t("settings.channelForm.telegram.addButton")}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.type === "email" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("settings.channelForm.email.title")}</CardTitle>
            <CardDescription>{t("settings.channelForm.email.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.email.host")}</Label>
                <Input
                  value={state.email.host}
                  onChange={(e) => dispatch({ type: "email", patch: { host: e.target.value } })}
                  disabled={props.pending}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.email.port")}</Label>
                <Input
                  value={state.email.port}
                  onChange={(e) => dispatch({ type: "email", patch: { port: e.target.value } })}
                  disabled={props.pending}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="text-sm">{t("settings.channelForm.email.secure")}</div>
              <Switch
                checked={state.email.secure}
                onCheckedChange={(v) => dispatch({ type: "email", patch: { secure: v } })}
                disabled={props.pending}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.email.user")}</Label>
                <Input
                  value={state.email.user}
                  onChange={(e) => dispatch({ type: "email", patch: { user: e.target.value } })}
                  disabled={props.pending}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.email.pass")}</Label>
                <Input
                  value={state.email.pass}
                  onChange={(e) => dispatch({ type: "email", patch: { pass: e.target.value } })}
                  disabled={props.pending}
                  placeholder={t("settings.channelForm.email.passPlaceholder")}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.email.from")}</Label>
              <Input
                value={state.email.from}
                onChange={(e) => dispatch({ type: "email", patch: { from: e.target.value } })}
                disabled={props.pending}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.email.to")}</Label>
              <Input
                value={state.email.to}
                onChange={(e) => dispatch({ type: "email", patch: { to: e.target.value } })}
                disabled={props.pending}
                placeholder="a@x.com, b@y.com"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.email.subjectPrefix")}</Label>
                <Input
                  value={state.email.subjectPrefix}
                  onChange={(e) =>
                    dispatch({ type: "email", patch: { subjectPrefix: e.target.value } })
                  }
                  disabled={props.pending}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.email.timeoutMs")}</Label>
                <Input
                  value={state.email.timeoutMs}
                  onChange={(e) =>
                    dispatch({ type: "email", patch: { timeoutMs: e.target.value } })
                  }
                  disabled={props.pending}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.type === "serverchan3" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("settings.channelForm.serverchan3.title")}
            </CardTitle>
            <CardDescription>{t("settings.channelForm.serverchan3.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2">
              <Label>
                {props.mode === "edit"
                  ? t("settings.channelForm.serverchan3.sendKeyOptional")
                  : t("settings.channelForm.serverchan3.sendKey")}
              </Label>
              <Input
                value={state.serverchan3.sendKey}
                onChange={(e) =>
                  dispatch({ type: "serverchan3", patch: { sendKey: e.target.value } })
                }
                disabled={props.pending}
                placeholder={
                  props.mode === "edit"
                    ? t("settings.channelForm.serverchan3.keepPlaceholder")
                    : t("settings.channelForm.serverchan3.sendKeyPlaceholder")
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.serverchan3.tags")}</Label>
              <Input
                value={state.serverchan3.tags}
                onChange={(e) => dispatch({ type: "serverchan3", patch: { tags: e.target.value } })}
                disabled={props.pending}
                placeholder={t("settings.channelForm.serverchan3.tagsPlaceholder")}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.serverchan3.short")}</Label>
              <Input
                value={state.serverchan3.short}
                onChange={(e) =>
                  dispatch({ type: "serverchan3", patch: { short: e.target.value } })
                }
                disabled={props.pending}
                placeholder={t("settings.channelForm.serverchan3.shortPlaceholder")}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.type === "serverchanturbo" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("settings.channelForm.serverchanturbo.title")}
            </CardTitle>
            <CardDescription>
              {t("settings.channelForm.serverchanturbo.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2">
              <Label>
                {props.mode === "edit"
                  ? t("settings.channelForm.serverchanturbo.sendKeyOptional")
                  : t("settings.channelForm.serverchanturbo.sendKey")}
              </Label>
              <Input
                value={state.serverchanturbo.sendKey}
                onChange={(e) =>
                  dispatch({ type: "serverchanturbo", patch: { sendKey: e.target.value } })
                }
                disabled={props.pending}
                placeholder={
                  props.mode === "edit"
                    ? t("settings.channelForm.serverchanturbo.keepPlaceholder")
                    : t("settings.channelForm.serverchanturbo.sendKeyPlaceholder")
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.serverchanturbo.channel")}</Label>
              <Input
                value={state.serverchanturbo.channel}
                onChange={(e) =>
                  dispatch({ type: "serverchanturbo", patch: { channel: e.target.value } })
                }
                disabled={props.pending}
                placeholder={t("settings.channelForm.serverchanturbo.channelPlaceholder")}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.type === "bark" ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("settings.channelForm.bark.title")}</CardTitle>
            <CardDescription>{t("settings.channelForm.bark.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.bark.serverUrl")}</Label>
              <Input
                value={state.bark.serverUrl}
                onChange={(e) => dispatch({ type: "bark", patch: { serverUrl: e.target.value } })}
                disabled={props.pending}
                placeholder="https://api.day.app"
              />
            </div>
            <div className="grid gap-2">
              <Label>
                {props.mode === "edit"
                  ? t("settings.channelForm.bark.deviceKeyOptional")
                  : t("settings.channelForm.bark.deviceKey")}
              </Label>
              <Input
                value={state.bark.deviceKey}
                onChange={(e) => dispatch({ type: "bark", patch: { deviceKey: e.target.value } })}
                disabled={props.pending}
                placeholder={
                  props.mode === "edit" ? t("settings.channelForm.bark.keepPlaceholder") : ""
                }
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.bark.sound")}</Label>
                <Input
                  value={state.bark.sound}
                  onChange={(e) => dispatch({ type: "bark", patch: { sound: e.target.value } })}
                  disabled={props.pending}
                  placeholder={t("settings.channelForm.bark.soundPlaceholder")}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.channelForm.bark.group")}</Label>
                <Input
                  value={state.bark.group}
                  onChange={(e) => dispatch({ type: "bark", patch: { group: e.target.value } })}
                  disabled={props.pending}
                  placeholder={t("settings.channelForm.bark.groupPlaceholder")}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.bark.level")}</Label>
              <Select
                value={state.bark.level || "auto"}
                onValueChange={(v) =>
                  dispatch({ type: "bark", patch: { level: v === "auto" ? "" : v } })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("settings.channelForm.bark.levelPlaceholder")}
                  </SelectItem>
                  <SelectItem value="critical">critical</SelectItem>
                  <SelectItem value="timeSensitive">timeSensitive</SelectItem>
                  <SelectItem value="active">active</SelectItem>
                  <SelectItem value="passive">passive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("settings.channelForm.bark.icon")}</Label>
              <Input
                value={state.bark.icon}
                onChange={(e) => dispatch({ type: "bark", patch: { icon: e.target.value } })}
                disabled={props.pending}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.error ? (
        <div className="text-destructive text-sm" role="alert">
          {state.error}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={props.pending || !valid}>
          {props.pending
            ? t("common.saving")
            : props.mode === "edit"
              ? t("common.save")
              : t("common.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { adminLogin } from "@/api/admin";
import { PasswordInput } from "@/components/PasswordInput";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUserErrorMessage } from "@/lib/userErrors";
import { adminMeOptionalQueryKey, adminMeQueryKey } from "@/queries/admin";

interface LoginDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onSuccess?: () => void;
}

export function LoginDialog({ open, onOpenChange, onSuccess }: LoginDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");

  const login = useMutation({
    mutationFn: adminLogin,
    async onSuccess(data) {
      const me = { ok: true as const, user: data.user };
      await Promise.all([
        queryClient.cancelQueries({ queryKey: adminMeQueryKey }),
        queryClient.cancelQueries({ queryKey: adminMeOptionalQueryKey }),
      ]);
      queryClient.setQueryData(adminMeQueryKey, me);
      queryClient.setQueryData(adminMeOptionalQueryKey, me);
      setUsername("");
      setPassword("");
      onSuccess?.();
    },
  });

  const errorMessage = React.useMemo(() => {
    if (!login.error) return null;
    return getUserErrorMessage(login.error, t, {
      action: "login",
      fallback: t("login.loginFailed"),
      codeMessages: {
        invalid_credentials: t("login.invalidCredentials"),
        rate_limit_exceeded: t("login.rateLimited"),
      },
    });
  }, [login.error, t]);

  const closable = !!onOpenChange;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={closable}
        onInteractOutside={closable ? undefined : (e) => e.preventDefault()}
        onEscapeKeyDown={closable ? undefined : (e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("login.title")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              e.target instanceof HTMLInputElement
            ) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (login.isPending) return;
            login.mutate({ username: username.trim(), password });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="login-username">{t("login.username")}</Label>
            <Input
              id="login-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={login.isPending}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="login-password">{t("login.password")}</Label>
            <PasswordInput
              id="login-password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={login.isPending}
            />
          </div>

          {errorMessage ? (
            <div className="text-destructive text-sm" role="alert">
              {errorMessage}
            </div>
          ) : null}

          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? t("login.signingIn") : t("login.signIn")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

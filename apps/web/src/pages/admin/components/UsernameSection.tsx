import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { patchAdminUsername } from "@/api/adminAccount";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUserErrorMessage } from "@/lib/userErrors";
import { invalidateAdminMeQueries, useAdminMe } from "@/queries/admin";

export function UsernameSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useAdminMe();

  const [username, setUsername] = React.useState("");
  const usernameInitRef = React.useRef(false);
  React.useEffect(() => {
    if (usernameInitRef.current) return;
    const v = me.data?.user?.username ?? "";
    if (!v) return;
    setUsername(v);
    usernameInitRef.current = true;
  }, [me.data?.user?.username]);

  const [usernameCurrentPassword, setUsernameCurrentPassword] = React.useState("");
  const [usernameLocalError, setUsernameLocalError] = React.useState<string | null>(null);
  const [usernameSuccess, setUsernameSuccess] = React.useState<string | null>(null);

  const updateUsername = useMutation({
    mutationFn: patchAdminUsername,
    async onSuccess(res) {
      setUsername(res.username);
      setUsernameCurrentPassword("");
      setUsernameLocalError(null);
      setUsernameSuccess(t("account.username.success"));
      await invalidateAdminMeQueries(queryClient);
    },
  });

  const usernameErrorMessage = React.useMemo(() => {
    if (usernameLocalError) return usernameLocalError;
    if (!updateUsername.error) return null;
    return getUserErrorMessage(updateUsername.error, t, {
      action: "update",
      fallback: t("common.errors.saveFailed"),
      codeMessages: {
        invalid_credentials: t("account.errors.invalidCredentials"),
        invalid_username: t("account.errors.invalidUsername"),
        invalid_password: t("account.errors.invalidPassword"),
        username_taken: t("account.errors.usernameTaken"),
      },
    });
  }, [updateUsername.error, usernameLocalError, t]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account.username.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setUsernameSuccess(null);

            const nextUsername = username.trim();
            if (!nextUsername || nextUsername.length > 64) {
              setUsernameLocalError(t("account.errors.invalidUsername"));
              return;
            }
            if (!usernameCurrentPassword) {
              setUsernameLocalError(t("account.errors.invalidPassword"));
              return;
            }

            updateUsername.mutate({
              username: nextUsername,
              currentPassword: usernameCurrentPassword,
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="account-username">{t("account.username.newUsername")}</Label>
            <Input
              id="account-username"
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setUsernameLocalError(null);
                setUsernameSuccess(null);
              }}
              disabled={updateUsername.isPending}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="account-username-current-password">
              {t("account.username.currentPassword")}
            </Label>
            <Input
              id="account-username-current-password"
              type="password"
              autoComplete="current-password"
              value={usernameCurrentPassword}
              onChange={(e) => {
                setUsernameCurrentPassword(e.target.value);
                setUsernameLocalError(null);
              }}
              disabled={updateUsername.isPending}
            />
          </div>

          {usernameErrorMessage ? (
            <div className="text-destructive text-sm" role="alert">
              {usernameErrorMessage}
            </div>
          ) : null}
          {usernameSuccess ? (
            <div className="text-muted-foreground text-sm">{usernameSuccess}</div>
          ) : null}

          <div>
            <Button type="submit" disabled={updateUsername.isPending}>
              {updateUsername.isPending
                ? t("account.username.updating")
                : t("account.username.submit")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

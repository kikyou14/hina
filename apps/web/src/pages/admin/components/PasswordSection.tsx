import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { toast } from "sonner";

import { patchAdminPassword } from "@/api/adminAccount";
import { PasswordInput } from "@/components/PasswordInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { getUserErrorMessage } from "@/lib/userErrors";
import { invalidateAdminMeQueries } from "@/queries/admin";

export function PasswordSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [passwordCurrentPassword, setPasswordCurrentPassword] = React.useState("");
  const [passwordNewPassword, setPasswordNewPassword] = React.useState("");
  const [passwordConfirmPassword, setPasswordConfirmPassword] = React.useState("");
  const [passwordLocalError, setPasswordLocalError] = React.useState<string | null>(null);

  const updatePassword = useMutation({
    mutationFn: patchAdminPassword,
    async onSuccess() {
      setPasswordCurrentPassword("");
      setPasswordNewPassword("");
      setPasswordConfirmPassword("");
      setPasswordLocalError(null);
      await invalidateAdminMeQueries(queryClient);
      toast.success(t("account.password.success"));
      navigate("/", { replace: true });
    },
  });

  const passwordErrorMessage = React.useMemo(() => {
    if (passwordLocalError) return passwordLocalError;
    if (!updatePassword.error) return null;
    return getUserErrorMessage(updatePassword.error, t, {
      action: "update",
      fallback: t("common.errors.saveFailed"),
      codeMessages: {
        invalid_credentials: t("account.errors.invalidCredentials"),
        invalid_password: t("account.errors.invalidPassword"),
      },
    });
  }, [updatePassword.error, passwordLocalError, t]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("account.password.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPasswordLocalError(null);

            if (!passwordCurrentPassword) {
              setPasswordLocalError(t("account.errors.invalidPassword"));
              return;
            }
            if (!passwordNewPassword || passwordNewPassword.length < 8) {
              setPasswordLocalError(t("account.errors.invalidPassword"));
              return;
            }
            if (passwordNewPassword !== passwordConfirmPassword) {
              setPasswordLocalError(t("account.password.mismatch"));
              return;
            }

            updatePassword.mutate({
              currentPassword: passwordCurrentPassword,
              newPassword: passwordNewPassword,
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="account-password-current">
              {t("account.password.currentPassword")}
            </Label>
            <PasswordInput
              id="account-password-current"
              autoComplete="current-password"
              value={passwordCurrentPassword}
              onChange={(e) => {
                setPasswordCurrentPassword(e.target.value);
                setPasswordLocalError(null);
              }}
              disabled={updatePassword.isPending}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="account-password-new">{t("account.password.newPassword")}</Label>
            <PasswordInput
              id="account-password-new"
              autoComplete="new-password"
              value={passwordNewPassword}
              onChange={(e) => {
                setPasswordNewPassword(e.target.value);
                setPasswordLocalError(null);
              }}
              disabled={updatePassword.isPending}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="account-password-confirm">
              {t("account.password.confirmPassword")}
            </Label>
            <PasswordInput
              id="account-password-confirm"
              autoComplete="new-password"
              value={passwordConfirmPassword}
              onChange={(e) => {
                setPasswordConfirmPassword(e.target.value);
                setPasswordLocalError(null);
              }}
              disabled={updatePassword.isPending}
            />
          </div>

          {passwordErrorMessage ? (
            <div className="text-destructive text-sm" role="alert">
              {passwordErrorMessage}
            </div>
          ) : null}

          <div>
            <Button type="submit" disabled={updatePassword.isPending}>
              {updatePassword.isPending
                ? t("account.password.updating")
                : t("account.password.submit")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

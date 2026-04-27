import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { getUserErrorMessage } from "@/lib/userErrors";

type ConfirmVariant = "default" | "destructive";

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
  onConfirm?: () => void | Promise<unknown>;
  errorMessage?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = React.useContext(ConfirmContext);
  if (!fn) {
    throw new Error("useConfirm must be used inside <ConfirmDialogProvider>");
  }
  return fn;
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const [pending, setPending] = React.useState(false);

  const resolveRef = React.useRef<((confirmed: boolean) => void) | null>(null);

  const lastOptions = React.useRef<ConfirmOptions | null>(null);
  if (options) lastOptions.current = options;
  const displayed = options ?? lastOptions.current;

  const confirm = React.useCallback<ConfirmFn>((next) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setOptions(next);
    });
  }, []);

  const finish = React.useCallback((result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOptions(null);
    setPending(false);
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (open || pending) return;
    finish(false);
  };

  const handleCancel = () => {
    if (pending) return;
    finish(false);
  };

  const handleConfirm = async (event: React.MouseEvent) => {
    event.preventDefault();
    if (!options) return;
    if (!options.onConfirm) {
      finish(true);
      return;
    }
    setPending(true);
    try {
      await options.onConfirm();
      finish(true);
    } catch (err) {
      if (options.errorMessage === undefined) {
        finish(false);
        return;
      }
      const message = getUserErrorMessage(err, t, {
        action: options.variant === "destructive" ? "delete" : "request",
        fallback: options.errorMessage,
      });
      toast.error(message);
      setPending(false);
    }
  };

  const variant = displayed?.variant === "destructive" ? "destructive" : "default";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{displayed?.title}</AlertDialogTitle>
            {displayed?.description ? (
              <AlertDialogDescription>{displayed.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending} onClick={handleCancel}>
              {displayed?.cancelText ?? t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant })}
              disabled={pending}
              onClick={handleConfirm}
            >
              {displayed?.confirmText ?? t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

import * as React from "react";
import { useTranslation } from "react-i18next";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          onReset={() => this.setState({ hasError: false, error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function ErrorFallback({ error, onReset }: { error: Error | null; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{t("common.errorBoundary.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("common.errorBoundary.description")}</p>
        {error && import.meta.env.DEV ? (
          <pre className="bg-muted mx-auto max-w-full overflow-auto rounded-md p-3 text-left text-xs wrap-break-word whitespace-pre-wrap">
            {error.message}
          </pre>
        ) : null}
        <button
          type="button"
          className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
          onClick={() => {
            onReset();
            window.location.reload();
          }}
        >
          {t("common.errorBoundary.reload")}
        </button>
      </div>
    </div>
  );
}

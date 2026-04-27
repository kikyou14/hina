import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export function NotFoundPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("notFound.title"));
  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="container py-12">
        <Card>
          <CardHeader>
            <CardTitle>{t("notFound.title")}</CardTitle>
            <CardDescription>{t("notFound.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/">{t("notFound.goHome")}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

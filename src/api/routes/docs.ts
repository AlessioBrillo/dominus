import { Router } from 'express';
import type { Request, Response } from 'express';
import { OPENAPI_SPEC } from '../openapi-spec.js';

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DOMINUS API Reference</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>html { box-sizing: border-box; overflow-y: scroll; } *, *::before, *::after { box-sizing: inherit; } body { margin: 0; background: #0a0a0f; } .swagger-ui .topbar { display: none; } .swagger-ui { color: #e4e4e7; } .swagger-ui .info .title { color: #fafafa; } .swagger-ui .info { margin: 20px 0; } .swagger-ui .scheme-container { background: #18181b; box-shadow: none; border: 1px solid #27272a; border-radius: 8px; } .swagger-ui .opblock-tag { color: #e4e4e7; } .swagger-ui .opblock-tag:hover { background: #27272a; } .swagger-ui .opblock { border: 1px solid #27272a; background: #18181b; } .swagger-ui .opblock .opblock-summary-description { color: #a1a1aa; } .swagger-ui .opblock .opblock-summary-operation-id, .swagger-ui .opblock .opblock-summary-path, .swagger-ui .opblock .opblock-summary-path__deprecated { color: #e4e4e7; } .swagger-ui .opblock .opblock-section-header { background: #27272a; } .swagger-ui .opblock .opblock-section-header h4 { color: #e4e4e7; } .swagger-ui .opblock .tab li { color: #a1a1aa; } .swagger-ui table thead tr td, .swagger-ui table thead tr th { color: #e4e4e7; border-bottom: 1px solid #27272a; } .swagger-ui .parameter__name, .swagger-ui .parameter__type, .swagger-ui .parameter__in, .swagger-ui .parameter__extension, .swagger-ui .prop-name, .swagger-ui .prop-type, .swagger-ui .response-col_status, .swagger-ui .response-col_description { color: #e4e4e7; } .swagger-ui .model-box { background: #27272a; } .swagger-ui .model-title { color: #e4e4e7; } .swagger-ui .btn { color: #e4e4e7; border-color: #52525b; } .swagger-ui select { color: #e4e4e7; background: #27272a; border-color: #52525b; } .swagger-ui .models-control { color: #e4e4e7; } .swagger-ui section.models { border: 1px solid #27272a; } .swagger-ui section.models.is-open h4 { border-bottom: 1px solid #27272a; } .swagger-ui .model-container { background: #27272a; } .swagger-ui .model-container:hover { background: #3f3f46; } .swagger-ui .model { color: #e4e4e7; } .swagger-ui .model .property.primitive { color: #a1a1aa; } .swagger-ui .model .property { color: #e4e4e7; } .swagger-ui .prop-required { color: #ef4444; } .swagger-ui .response-col_description__inner div.markdown p { color: #e4e4e7; } .swagger-ui .markdown p, .swagger-ui .markdown pre, .swagger-ui .renderedMarkdown p, .swagger-ui .renderedMarkdown pre { color: #e4e4e7; } .swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: #e4e4e7; } .swagger-ui .response-control-media-type__accept-message { color: #22c55e; } .swagger-ui .response-control-media-type { color: #a1a1aa; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  SwaggerUIBundle({
    url: '/api/v1/docs.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1,
    docExpansion: 'list',
  });
</script>
</body>
</html>`;

export function createDocsRouter(): Router {
  const router = Router();

  router.get('/docs', (_req: Request, res: Response): void => {
    res.status(200).type('text/html').send(SWAGGER_UI_HTML);
  });

  router.get('/docs.json', (_req: Request, res: Response): void => {
    res.status(200).json(OPENAPI_SPEC);
  });

  return router;
}

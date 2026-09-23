export function GET() {
  return Response.json({ status: 'ok', service: 'trendbench', scope: 'application-process' });
}

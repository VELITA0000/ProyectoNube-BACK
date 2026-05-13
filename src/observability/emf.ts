/**
 * CloudWatch Embedded Metric Format — una línea JSON en stdout; Lambda extrae métricas custom.
 * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 */
export const APP_METRICS_NAMESPACE = "Lumiere/App";

export function emitEmfCount(
  metrics: Record<string, number>,
  dimensions: Record<string, string>,
  namespace: string = APP_METRICS_NAMESPACE,
): void {
  const dimensionNames = Object.keys(dimensions).sort();
  const doc = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [dimensionNames],
          Metrics: Object.keys(metrics).map((name) => ({ Name: name, Unit: "Count" })),
        },
      ],
    },
    ...dimensions,
    ...metrics,
  };
  console.log(JSON.stringify(doc));
}

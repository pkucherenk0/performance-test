#!/usr/bin/env bash

set -euo pipefail

# ===== Default values =====
NAMESPACE="uat"
SERVICE_NAME=""

# ===== Usage information =====
usage() {
  cat <<EOF
Usage:
  $0 -s <service-name> [-n <namespace>]

Options:
  -s  Service name (required, Deployment or StatefulSet)
  -n  Namespace (optional, default: uat)
  -h  Show this help message

Examples:
  $0 -s order-service
  $0 -s mysql-sts -n prod
EOF
}

# ===== Parse CLI arguments =====
while getopts ":s:n:h" opt; do
  case $opt in
    s)
      SERVICE_NAME=$OPTARG
      ;;
    n)
      NAMESPACE=$OPTARG
      ;;
    h)
      usage
      exit 0
      ;;
    \?)
      echo "❌ Invalid option: -$OPTARG"
      usage
      exit 1
      ;;
    :)
      echo "❌ Option -$OPTARG requires an argument"
      usage
      exit 1
      ;;
  esac
done

# ===== Validate required arguments =====
if [ -z "$SERVICE_NAME" ]; then
  echo "❌ Service name is required (-s)"
  usage
  exit 1
fi

# ===== Validate KUBECONFIG environment variable =====
if [ -z "${KUBECONFIG:-}" ]; then
  echo "❌ KUBECONFIG environment variable is not set"
  echo "Example:"
  echo "  export KUBECONFIG=/etc/kubernetes/admin.conf"
  exit 1
fi

echo "====== Kubernetes Rolling Restart ======"
echo "Service    : ${SERVICE_NAME}"
echo "Namespace  : ${NAMESPACE}"
echo "KUBECONFIG : ${KUBECONFIG}"
echo "========================================"

# ===== Detect resource type =====
if kubectl get deployment "$SERVICE_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
  RESOURCE_TYPE="deployment"
elif kubectl get statefulset "$SERVICE_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
  RESOURCE_TYPE="statefulset"
else
  echo "❌ No Deployment or StatefulSet found for service: ${SERVICE_NAME} in namespace: ${NAMESPACE}"
  exit 1
fi

echo "🔍 Detected resource type: ${RESOURCE_TYPE}"

# ===== Trigger rolling restart =====
echo "🚀 Starting rolling restart..."
kubectl rollout restart "$RESOURCE_TYPE" "$SERVICE_NAME" -n "$NAMESPACE"

# ===== Wait for rollout to complete =====
echo "⏳ Waiting for rollout to complete..."
kubectl rollout status "$RESOURCE_TYPE" "$SERVICE_NAME" -n "$NAMESPACE"

echo "✅ Rolling restart completed successfully"

# PICouncil Infrastructure

Pulumi infrastructure as code for PICouncil platform.

## Tech Stack
- Pulumi (TypeScript)
- AWS (ECS Fargate, RDS PostgreSQL, ALB, S3, ECR)
- Cloudflare (DNS, CDN - optional)

## Prerequisites
1. AWS CLI configured with credentials
2. Pulumi CLI installed
3. Node.js 20+

## Setup

```bash
# Install dependencies
yarn

# Login to Pulumi
pulumi login

# Select stack
pulumi stack select prod

# Set secrets
pulumi config set --secret dbPassword <password>
pulumi config set --secret jwtSecret <jwt-secret-min-32-chars>
pulumi config set certificateArn <acm-certificate-arn>
```

## Deploy

```bash
# Preview changes
pulumi preview

# Deploy
pulumi up

# Get outputs
pulumi stack output
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Cloudflare                           │
│                     (DNS + CDN + SSL)                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Application Load Balancer                 │
│                     (HTTPS → HTTP)                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      ECS Fargate                            │
│                   (picouncil-server)                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    RDS PostgreSQL                           │
│                    (Private Subnet)                         │
└─────────────────────────────────────────────────────────────┘
```

## Resources Created

| Resource | Description |
|----------|-------------|
| VPC | 10.0.0.0/16 with public/private subnets |
| ALB | Application Load Balancer with HTTPS |
| ECS Cluster | Fargate cluster |
| ECS Service | picouncil-server container |
| RDS | PostgreSQL 16 (db.t4g.micro) |
| ECR | Container registry |
| S3 | File storage bucket |
| CloudWatch | Logs (30 day retention) |
| SSM | Parameter Store for secrets |

## Costs (Estimated)

| Resource | Monthly Cost |
|----------|--------------|
| ECS Fargate (0.25 vCPU, 0.5GB) | ~$10 |
| RDS PostgreSQL (t4g.micro) | ~$15 |
| ALB | ~$20 |
| NAT Gateway | ~$35 |
| S3, ECR, CloudWatch | ~$5 |
| **Total** | **~$85/month** |

## Deployment Flow

1. Build and push image:
   ```bash
   cd picouncil-server
   make ecr-deploy
   ```

2. Deploy infrastructure:
   ```bash
   cd picouncil-infra
   pulumi up
   ```

## Scaling

To scale the service:
```bash
# Update desired count
pulumi config set desiredCount 2
pulumi up
```

## Monitoring

- CloudWatch Logs: `/ecs/picouncil-server`
- Container Insights: Enabled on cluster
- Health Check: `/health` endpoint

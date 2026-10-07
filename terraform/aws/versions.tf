terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Credentials come from the environment (AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN / REGION),
# which the backend writes per-run (see awsauth.writeCredsEnv) or the ambient chain provides.
provider "aws" {
  region = var.region
}

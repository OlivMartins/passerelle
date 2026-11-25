/*
 * Banc « Log vers Vector » : les échantillons de examples/logs, le format que Passerelle doit y reconnaître, et
 * quelques champs attendus, écrits à la main d’après la ligne (et non recopiés de la sortie du moteur).
 *
 *   file     l’échantillon, dans examples/logs
 *   format   l’identifiant du format reconnu (LOG_FORMAT_LABELS)
 *   events   nombre d’événements (une trace de pile appartient à l’événement qu’elle suit)
 *   otel, ecs  { <n° d’événement>: { <champ>: <valeur> } } ; <champ> est le nom affiché dans l’onglet « Champs »
 *            (attributes["…"], resources["…"] ou un chemin pointé) ; une valeur undefined exige l’absence du champ
 *
 * Joué sans Vector par npm test (scripts/test.mjs), et dans Vector par tests/logs/vector.mjs.
 */
export const CASES = [
  /* ---------- Web ---------- */
  {
    file: 'nginx_acces.log',
    format: 'combined',
    events: 4,
    otel: {
      0: {
        'attributes["client.address"]': '203.0.113.10',
        'attributes["http.request.method"]': 'GET',
        'attributes["url.path"]': '/index.html',
        'attributes["http.response.status_code"]': 200,
        'attributes["http.response.body.size"]': 5320,
        'attributes["network.protocol.version"]': '1.1',
        'attributes["http.request.header.referer"]': undefined,
        timestamp: '2026-05-01T08:00:00Z'
      },
      1: {
        'attributes["user.name"]': 'alice',
        'attributes["url.query"]': 'source=mobile&lang=fr',
        'attributes["http.request.header.referer"]': 'https://shop.example.com/panier',
        'attributes["user_agent.original"]': 'okhttp/4.12.0'
      },
      3: { 'attributes["http.request.line"]': undefined, 'attributes["http.response.status_code"]': 400 }
    },
    ecs: {
      0: {
        'source.address': '203.0.113.10',
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'http.response.body.bytes': 5320,
        'http.version': '1.1',
        'network.protocol': 'http',
        '@timestamp': '2026-05-01T08:00:00Z',
        'event.original':
          '203.0.113.10 - - [01/May/2026:10:00:00 +0200] "GET /index.html HTTP/1.1" 200 5320 "-" "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"'
      }
    }
  },
  {
    file: 'nginx_main_xff.log',
    format: 'combined',
    events: 2,
    otel: {
      1: {
        'attributes["http.request.header.x-forwarded-for"]': '203.0.113.77, 10.0.0.1',
        'attributes["user.name"]': 'bob'
      }
    },
    ecs: { 0: { 'network.forwarded_ip': undefined, 'user_agent.original': 'kube-probe/1.30' } }
  },
  {
    file: 'apache_acces.log',
    format: 'combined',
    events: 2,
    otel: {
      0: {
        'attributes["user.name"]': 'frank',
        timestamp: '2025-10-10T20:55:36Z',
        'attributes["http.response.body.size"]': 2326
      },
      1: { 'attributes["http.response.status_code"]': 304, 'attributes["http.response.body.size"]': undefined }
    },
    ecs: { 0: { 'http.version': '1.0', 'url.path': '/apache_pb.gif' } }
  },
  {
    file: 'nginx_erreur.log',
    format: 'nginxError',
    events: 3,
    otel: {
      0: {
        severity_text: 'error',
        severity_number: 17,
        'resources["process.pid"]': 1234,
        'attributes["nginx.connection_id"]': 5678,
        'attributes["client.address"]': '203.0.113.10',
        'attributes["server.address"]': 'shop.example.com',
        'attributes["url.path"]': '/robots.txt',
        'attributes["http.request.header.host"]': 'shop.example.com',
        message: 'open() "/usr/share/nginx/html/robots.txt" failed (2: No such file or directory)',
        timestamp: '2026-05-01T10:00:05Z'
      },
      1: {
        'attributes["nginx.upstream"]': 'http://10.0.2.15:8080/api/export?format=csv',
        'attributes["url.query"]': 'format=csv'
      },
      2: { severity_number: 10, message: 'signal process started', 'attributes["client.address"]': undefined }
    },
    ecs: { 0: { 'log.level': 'error', 'nginx.error.connection_id': 5678, 'url.domain': 'shop.example.com' } }
  },
  {
    file: 'apache_erreur.log',
    format: 'apacheError',
    events: 3,
    otel: {
      0: {
        severity_text: 'error',
        'attributes["apache.module"]': 'core',
        'attributes["apache.error.code"]': 'AH00124',
        'attributes["client.address"]': '203.0.113.10',
        'attributes["client.port"]': 51234,
        'attributes["thread.id"]': 140234,
        timestamp: '2026-05-01T10:00:00.123456Z'
      },
      1: { severity_number: 10, 'attributes["client.address"]': undefined }
    },
    ecs: { 2: { 'error.code': 'AH01630', 'apache.error.module': 'authz_core', 'source.port': 40022 } }
  },

  /* ---------- Applications ---------- */
  {
    file: 'java_logback.log',
    format: 'javaThreadFirst',
    events: 4,
    otel: {
      0: { 'scope.name': 'com.example.boutique.Application', 'attributes["thread.name"]': 'main', severity_number: 9 },
      2: {
        message: 'Échec du paiement de la commande 1042',
        'attributes["exception.type"]': 'java.lang.IllegalStateException',
        'attributes["exception.message"]': 'Solde insuffisant pour la commande 1042',
        severity_text: 'ERROR'
      }
    },
    ecs: {
      2: {
        'error.type': 'java.lang.IllegalStateException',
        'log.logger': 'com.example.boutique.service.PaiementService'
      }
    }
  },
  {
    file: 'java_spring_boot.log',
    format: 'springBoot',
    events: 3,
    otel: {
      0: {
        'resources["service.name"]': 'boutique',
        'resources["process.pid"]': 4321,
        'attributes["thread.name"]': 'main',
        timestamp: '2026-05-01T08:00:00.123Z'
      },
      2: {
        'attributes["exception.type"]': 'java.lang.NullPointerException',
        'scope.name': 'o.a.c.c.C.[.[.[/].[dispatcherServlet]'
      }
    },
    ecs: { 1: { 'process.thread.name': 'nio-8080-exec-2', 'log.level': 'WARN', 'service.name': 'boutique' } }
  },
  {
    file: 'python_logging.log',
    format: 'pythonDash',
    events: 4,
    otel: {
      1: { severity_text: 'WARNING', severity_number: 13, 'scope.name': 'facturation.worker' },
      2: {
        message: 'Export PDF impossible pour la facture 9002',
        'attributes["exception.type"]': 'ValueError',
        'attributes["exception.message"]': 'gabarit introuvable : facture_v3',
        timestamp: '2026-05-01T10:00:01.002Z'
      }
    },
    ecs: { 2: { 'error.type': 'ValueError', 'log.logger': 'facturation.export' } }
  },
  {
    file: 'python_gunicorn.log',
    format: 'gunicorn',
    events: 4,
    otel: {
      3: {
        severity_text: 'CRITICAL',
        severity_number: 21,
        'resources["process.pid"]': 1,
        message: 'WORKER TIMEOUT (pid:7)'
      }
    },
    ecs: { 2: { 'process.pid': 7, '@timestamp': '2026-05-01T10:00:00Z' } }
  },
  {
    file: 'go_std.log',
    format: 'goStd',
    events: 3,
    otel: {
      0: {
        'attributes["code.file.path"]': 'main.go',
        'attributes["code.line.number"]': 42,
        message: 'démarrage du serveur sur :8080'
      }
    },
    ecs: { 2: { 'log.origin.file.name': 'db.go', 'log.origin.file.line': 88 } }
  },
  {
    file: 'go_logfmt.log',
    format: 'logfmt',
    events: 3,
    otel: {
      0: {
        message: 'serveur démarré',
        severity_text: 'INFO',
        'attributes["addr"]': ':8080',
        timestamp: '2026-05-01T08:00:00Z'
      },
      2: {
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        'attributes["exception.message"]': 'context deadline exceeded'
      }
    },
    ecs: { 1: { 'log.level': 'WARN', duree_ms: '812' } }
  },
  {
    file: 'go_zap_json.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        message: 'requête traitée',
        'attributes["code.file.path"]': 'server/http.go',
        'attributes["code.line.number"]': 58,
        'attributes["status"]': 200,
        'attributes["duration"]': 0.0123,
        timestamp: '2026-05-01T08:00:00.123456Z'
      },
      1: { severity_number: 17, 'attributes["exception.message"]': 'upstream indisponible' }
    },
    ecs: {
      1: { 'error.message': 'upstream indisponible', 'error.stack_trace': 'main.handler\n\t/app/server/http.go:61' }
    }
  },
  {
    file: 'kubernetes_klog.log',
    format: 'klog',
    events: 3,
    otel: {
      0: {
        severity_text: 'INFO',
        message: 'Synchronisation du déploiement',
        'attributes["deployment"]': 'boutique/api',
        'attributes["replicas"]': '3',
        'attributes["code.file.path"]': 'controller.go'
      },
      2: { severity_text: 'ERROR', 'attributes["thread.id"]': 17 }
    },
    ecs: { 1: { 'log.level': 'WARN', 'log.origin.file.line': 539 } }
  },
  {
    file: 'otel_collector.log',
    format: 'otelZap',
    events: 4,
    otel: {
      0: { message: 'Starting otelcol-contrib...', 'attributes["Version"]': '0.120.0', 'attributes["NumCPU"]': 8 },
      3: {
        severity_number: 17,
        'attributes["dropped_items"]': 512,
        'attributes["code.file.path"]': 'exporterhelper/queue_sender.go'
      }
    },
    ecs: { 2: { 'labels.pipeline': 'logs', 'log.level': 'warn' } }
  },
  {
    file: 'node_pino.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        severity_text: 'info',
        severity_number: 9,
        'resources["host.name"]': 'api-7c9f',
        'attributes["req.method"]': 'GET',
        timestamp: '2026-05-01T10:00:00.123Z'
      },
      1: { severity_text: 'error', 'attributes["exception.type"]': 'Error' }
    },
    ecs: { 1: { 'log.level': 'error', 'process.pid': 42 } }
  },
  {
    file: 'docker_json.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        message: 'Serveur prêt sur le port 3000',
        'attributes["log.iostream"]': 'stdout',
        timestamp: '2026-05-01T10:00:00.123456789Z'
      }
    },
    ecs: { 1: { stream: 'stderr', message: 'Erreur : connexion Redis refusée' } }
  },

  /* ---------- Briques de la plateforme ---------- */
  {
    file: 'elasticsearch_json.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        'resources["service.name"]': 'ES_ECS',
        'scope.name': 'org.elasticsearch.node.Node',
        'attributes["elasticsearch.node.name"]': 'es-node-1'
      },
      1: { severity_text: 'WARN', 'attributes["thread.name"]': 'elasticsearch[es-node-1][generic][T#3]' }
    },
    ecs: {
      0: {
        'log.level': 'INFO',
        'elasticsearch.cluster.name': 'production',
        'ecs.version': '1.2.0',
        '@timestamp': '2026-05-01T10:00:00.123Z'
      }
    }
  },
  {
    file: 'elasticsearch_texte.log',
    format: 'elasticsearchText',
    events: 3,
    otel: {
      0: {
        'scope.name': 'o.e.n.Node',
        'attributes["elasticsearch.node.name"]': 'es-node-1',
        message: 'started',
        timestamp: '2026-05-01T10:00:00.123Z'
      },
      2: { severity_text: 'ERROR', 'scope.name': 'o.e.b.ElasticsearchUncaughtExceptionHandler' }
    },
    ecs: { 1: { 'log.level': 'WARN', 'elasticsearch.node.name': 'es-node-1' } }
  },
  {
    file: 'kafka_server.log',
    format: 'kafka',
    events: 4,
    otel: {
      0: {
        'attributes["kafka.component"]': 'KafkaServer id=1',
        message: 'started',
        'scope.name': 'kafka.server.KafkaServer'
      },
      3: {
        message: "Uncaught exception in scheduled task 'flush-log'",
        'attributes["exception.type"]': 'java.io.IOException',
        'attributes["exception.message"]': 'No space left on device'
      }
    },
    ecs: { 2: { 'kafka.log.component': 'ReplicaFetcher replicaId=1, leaderId=2, fetcherId=0', 'log.level': 'WARN' } }
  },
  {
    file: 'clickhouse_serveur.log',
    format: 'clickhouse',
    events: 4,
    otel: {
      0: {
        severity_text: 'Information',
        severity_number: 9,
        'scope.name': 'Application',
        'attributes["clickhouse.query_id"]': undefined
      },
      2: {
        'attributes["clickhouse.query_id"]': '9f1c2d3e-0a4b-4c5d-8e6f-7a8b9c0d1e2f',
        severity_number: 17,
        'attributes["thread.id"]': 4250
      }
    },
    ecs: {
      3: {
        'log.level': 'Warning',
        'log.logger': 'MergeTreeBackgroundExecutor',
        '@timestamp': '2026-05-01T10:00:02.000001Z'
      }
    }
  },
  {
    file: 'clickhouse_json.log',
    format: 'json',
    events: 2,
    otel: {
      1: {
        severity_text: 'Error',
        'scope.name': 'executeQuery',
        'attributes["query_id"]': '9f1c2d3e-0a4b-4c5d-8e6f-7a8b9c0d1e2f',
        timestamp: '2026-05-01T10:00:01.345678Z'
      }
    },
    ecs: { 0: { 'log.logger': 'Application', message: 'Ready for connections.' } }
  },
  {
    file: 'nomad.log',
    format: 'hclog',
    events: 4,
    otel: {
      1: {
        'scope.name': 'client.alloc_runner.task_runner',
        message: 'Task event',
        'attributes["task"]': 'redis',
        'attributes["msg"]': 'Task started by client',
        'attributes["failed"]': 'false',
        timestamp: '2026-05-01T08:00:01.456Z'
      },
      3: { severity_text: 'ERROR', message: 'yamux: keepalive failed: i/o deadline reached' }
    },
    ecs: { 0: { 'labels.name': 'docker', 'log.logger': 'agent', message: 'detected plugin' } }
  },
  {
    file: 'nomad_json.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        message: 'Task event',
        'scope.name': 'client.alloc_runner.task_runner',
        'attributes["failed"]': false,
        timestamp: '2026-05-01T08:00:01.456789Z'
      }
    },
    ecs: { 1: { 'log.level': 'error', 'log.logger': 'nomad.rpc' } }
  },
  {
    file: 'vault_serveur.log',
    format: 'hclog',
    events: 4,
    otel: {
      0: {
        'scope.name': 'core',
        message: 'successfully mounted',
        'attributes["namespace"]': 'ID: root. Path: ',
        'attributes["path"]': 'secret/'
      },
      3: { 'attributes["error"]': 'context canceled', severity_number: 17 }
    },
    ecs: { 1: { message: 'vault is unsealed', 'log.level': 'INFO' } }
  },
  {
    file: 'vault_audit.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        'attributes["request.path"]': 'secret/data/boutique/db',
        'attributes["auth.display_name"]': 'oidc-alice',
        timestamp: '2026-05-01T08:00:10.123456Z'
      },
      1: { 'attributes["exception.message"]': 'permission denied', 'attributes["type"]': 'response' }
    },
    ecs: { 0: { 'request.operation': 'read', 'auth.policies': ['default', 'dev'] } }
  },

  /* ---------- Linux ---------- */
  {
    file: 'syslog_messages.log',
    format: 'syslog3164',
    events: 5,
    otel: {
      0: {
        'resources["host.name"]': 'web01',
        'resources["service.name"]': 'sshd',
        'resources["process.pid"]': 2211,
        'attributes["user.name"]': 'deploy',
        'attributes["source.address"]': '198.51.100.20',
        'attributes["source.port"]': 52344,
        'attributes["event.outcome"]': 'success'
      },
      1: {
        'attributes["user.name"]': 'admin',
        'attributes["event.outcome"]': 'failure',
        'attributes["ssh.method"]': 'password'
      },
      2: {
        'attributes["user.effective.name"]': 'root',
        'attributes["process.command_line"]': '/usr/bin/systemctl restart nginx'
      }
    },
    ecs: {
      0: { 'source.ip': '198.51.100.20', 'process.name': 'sshd', 'system.auth.ssh.method': 'publickey' },
      4: { 'process.name': 'CRON' }
    }
  },
  {
    file: 'syslog_kern.log',
    format: 'syslog3164',
    events: 4,
    otel: {
      1: {
        'attributes["host.uptime"]': 3605.123456,
        message: 'eth0: Link is Up - 10Gbps Full Duplex, Flow Control: None'
      },
      2: { message: 'Out of memory: Killed process 4242 (java) total-vm:8123456kB, anon-rss:4123456kB' }
    },
    ecs: { 0: { 'host.uptime': 0.0, 'process.name': 'kernel' } }
  },
  {
    file: 'syslog_rfc5424.log',
    format: 'syslog5424',
    events: 3,
    otel: {
      0: {
        'attributes["syslog.priority"]': 34,
        'attributes["syslog.facility"]': 'auth',
        'attributes["syslog.severity"]': 'crit',
        severity_number: 21,
        'resources["process.pid"]': undefined,
        'attributes["syslog.msgid"]': 'ID47',
        timestamp: '2026-05-01T10:00:00.003Z'
      },
      1: {
        'attributes["syslog.facility"]': 'local4',
        'attributes["syslog.severity"]': 'notice',
        'attributes["syslog.structured_data"]': '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"]',
        timestamp: '2026-05-01T08:00:01Z'
      },
      2: {
        'resources["process.pid"]': 4242,
        'attributes["syslog.msgid"]': undefined,
        message: 'message sans données structurées'
      }
    },
    ecs: {
      0: {
        'log.syslog.facility.name': 'auth',
        'log.syslog.severity.name': 'crit',
        'host.name': 'mymachine.example.com'
      }
    }
  },
  {
    file: 'syslog_iso.log',
    format: 'syslogIso',
    events: 3,
    otel: {
      0: { timestamp: '2026-05-01T08:00:00.123456Z', 'resources["service.name"]': 'systemd' },
      1: { 'attributes["user.name"]': 'deploy' },
      2: { 'attributes["host.uptime"]': 3605.123456 }
    },
    ecs: { 1: { 'source.ip': '198.51.100.20', 'event.outcome': 'success' } }
  },
  {
    file: 'journald_short_iso.log',
    format: 'syslogIso',
    events: 3,
    otel: {
      1: { 'resources["service.name"]': 'nginx', 'resources["process.pid"]': 3355, timestamp: '2026-05-01T08:00:01Z' }
    },
    ecs: { 0: { 'host.name': 'web01', 'process.pid': 1 } }
  },
  {
    file: 'journald_json.log',
    format: 'json',
    events: 2,
    otel: {
      0: {
        'resources["service.name"]': 'systemd',
        'resources["host.name"]': 'web01',
        severity_text: 'info',
        timestamp: '2026-05-01T10:00:00.123456Z'
      },
      1: { severity_text: 'err', severity_number: 17, 'resources["process.pid"]': 2215 }
    },
    ecs: { 1: { 'log.level': 'err', _SYSTEMD_UNIT: 'ssh.service' } }
  },
  {
    file: 'dmesg.log',
    format: 'dmesg',
    events: 3,
    otel: {
      2: {
        'attributes["host.uptime"]': 7211.654321,
        message: 'Out of memory: Killed process 4242 (java) total-vm:8123456kB, anon-rss:4123456kB'
      }
    },
    ecs: { 1: { message: 'ACPI: Added _OSI(Module Device)' } }
  },
  {
    file: 'auditd.log',
    format: 'auditd',
    events: 2,
    otel: {
      0: {
        'attributes["auditd.record_type"]': 'USER_START',
        'attributes["auditd.sequence"]': 4521,
        'attributes["auditd.acct"]': undefined,
        'attributes["auditd.msg"]':
          'op=PAM:session_open grantors=pam_selinux,pam_loginuid acct="deploy" exe="/usr/sbin/sshd" hostname=198.51.100.20 addr=198.51.100.20 terminal=ssh res=success',
        timestamp: '2026-05-01T10:00:00.123Z'
      },
      1: { 'attributes["auditd.exe"]': '/usr/bin/systemctl', 'attributes["auditd.key"]': 'privileged' }
    },
    ecs: { 1: { 'auditd.log.syscall': '59', 'auditd.log.record_type': 'SYSCALL' } }
  },

  /* ---------- Non reconnu ---------- */
  {
    file: 'inconnu.log',
    format: 'none',
    events: 3,
    otel: { 0: { 'attributes["log.parse.error"]': 'format non reconnu par Passerelle' } },
    ecs: { 0: { tags: ['_vrl_parse_failure'] } }
  }
];

// Valeur d’un champ d’un événement prédit (eventJSON) d’après son nom affiché : attributes["…"], resources["…"], a.b.c
export function fieldOf(ev, name) {
  const m = /^(attributes|resources)\["(.*)"\]$/.exec(name);
  if (m) return ev[m[1]] ? ev[m[1]][m[2]] : undefined;
  if (name in ev) return ev[name];
  return name.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), ev);
}

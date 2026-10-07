# Mr Pizza - Gestao privada

## Arranque local com Node.js

Requer Node.js 18 ou superior. No PowerShell, se `npm` for bloqueado pela
política de execução do Windows, use `npm.cmd`:

```powershell
npm.cmd install
Copy-Item .env.example .env
# Configure OPENROUTER_API_KEY (preferido) ou as chaves Gemini (GEMINI_API_KEY_1 a _4)
# e SUPABASE_URL e SUPABASE_ANON_KEY.
npm.cmd test
npm.cmd start
```

O servidor carrega `.env` automaticamente. Obtenha a chave Gemini no Google AI
Studio e os dados do projeto no painel Supabase. Use a chave **anon/publicável**
do Supabase, nunca a `service_role`. O servidor entrega ao browser apenas a
configuração publicável necessária para autenticação; a chave Gemini permanece
exclusivamente no backend. `.env`, `.env.local` e outros ficheiros de ambiente
estão excluídos do Git.

Depois abra `http://localhost:3000`. O servidor de desenvolvimento escuta apenas
em `127.0.0.1` e serve uma allowlist de assets públicos; `.env`, código backend,
schema, testes e ficheiros de dependências não são servidos pelo HTTP. A chave
Gemini fica apenas no servidor e
nunca é enviada para o navegador. O assistente só prepara uma operação e só
altera os dados depois de confirmação explícita.

Se a porta 3000 já estiver ocupada, escolha outra antes de arrancar:

```powershell
$env:PORT="3100"
npm.cmd start
```

Nesse caso, abra `http://localhost:3100`.

Se `OPENROUTER_API_KEY` estiver configurada, o assistente usa o OpenRouter com
fallback pela lista `OPENROUTER_MODELS` (por omissão: Gemini Flash, GPT-4o mini
e Claude 3.5 Sonnet). A lista deve ser um array JSON com 1 a 5 identificadores
únicos; a ordem controla a prioridade/fallback do OpenRouter. A chave fica
apenas no backend; nunca a coloques no JavaScript do browser ou no Git.
Configura `OPENROUTER_API_KEY` localmente no `.env` e reinicia o servidor. Se
não houver chave OpenRouter, o assistente usa as chaves Gemini configuradas.
Se nenhum provider estiver disponível, o chat mostra uma mensagem de
indisponibilidade e não inventa uma resposta nem executa uma ação.

### Diagnóstico da IA

- `openrouter_auth`: confirma se a chave está correta e ativa. Revoga qualquer
  chave que tenha sido partilhada/publicada e cria uma nova; não a envies pelo
  chat nem a guardes no código.
- `openrouter_rate_limited` ou `openrouter_unavailable`: confirma saldo, limites
  e disponibilidade dos modelos no painel OpenRouter. O array `models` permite
  fallback apenas entre modelos/capacidades a que a tua conta tem acesso; não
  garante serviço gratuito ou disponibilidade absoluta.
- Erro de configuração `OPENROUTER_MODELS`: verifica que o valor é JSON válido,
  por exemplo `["google/gemini-2.0-flash-001","openai/gpt-4o-mini"]`.
- O servidor termina com erro explícito se a lista configurada não for válida.
  Os logs registam o identificador do modelo que respondeu, nunca a chave.
- O timeout é controlado por `GEMINI_TIMEOUT_MS` (aplicado também ao OpenRouter,
  entre 1 e 60 segundos); erros transitórios podem ser repetidos uma vez.
Sem `SUPABASE_URL` e `SUPABASE_ANON_KEY`, a aplicação informa que não consegue
iniciar a ligação autenticada.

Se o login não conseguir contactar o Supabase, confirma em
**Project Settings → API** que `SUPABASE_URL` contém o **Project URL** atual
do projeto (e não o endereço do painel) e que o domínio resolve no DNS. Em
**Authentication → Users**, confirma também que a conta do gerente existe,
está ativa e, se necessário, tem o email confirmado.

Pedidos Gemini com falhas temporárias de quota, sobrecarga, timeout ou rede
tentam novamente uma vez. Se persistirem, o chat distingue a causa (chave
recusada, modelo indisponível, limite de pedidos, sobrecarga ou timeout) sem
mostrar segredos. O servidor regista o código de diagnóstico no terminal.

Configura as chaves Gemini autorizadas no `.env` usando apenas
`GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3` e
`GEMINI_API_KEY_4` (os sufixos numéricos são ordenados e valores repetidos são
removidos). Cada novo pedido
começa na chave seguinte em round-robin; perante HTTP 429/quota esgotada, o
servidor tenta uma vez cada outra chave configurada. Sobrecarga, timeout ou
falha de rede pode ser repetida uma vez na mesma chave, sem mascarar erros de
autenticação nem modelo inválido. Os logs mostram apenas o número do slot, nunca
a chave. Usa somente chaves de projetos sob teu controlo e respeita as quotas e
os termos do Google; várias chaves não aumentam nem contornam a quota do projeto.

## Regras de horários

- Domingo a quinta-feira: turno do dia das 11:00 às 18:00 e turno da noite das 18:00 às 00:00.
- Sexta-feira e sábado: turno do dia das 11:00 às 19:00 e turno da noite das 19:00 às 02:00.
- Cada funcionário tem exatamente 7 folgas por mês.
- As células da escala podem ser editadas diretamente, clicando nelas.
- Clicar repetidamente numa célula percorre dia, noite, folga e sem horário;
  “Sem horário” fica visualmente em branco. A coluna dos funcionários e o
  cabeçalho dos dias mantêm-se visíveis ao percorrer a tabela. O valor vazio é
  guardado como `unset` (um valor permitido pelo enum SQL), nunca como string
  vazia nem `NULL`.
- Duplo clique (ou toque prolongado no telemóvel) permite escrever um horário
  personalizado até 50 caracteres. Enter ou clique fora guarda; Escape cancela.
  O texto é mostrado como texto simples, não executa HTML, e também aparece nas
  exportações Excel e PDF. Os horários personalizados são informativos e não
  contam como turno do dia/noite ou folga nos indicadores de cobertura.
- Ao guardar uma alteração, a aplicação atualiza apenas a célula editada e os
  resumos relacionados; bloqueia temporariamente as outras células para evitar
  gravações simultâneas com estados diferentes. A persistência e as políticas
  de acesso são do Supabase; a aplicação não usa lowdb nem `db.json`.
- A geração automática respeita as 7 folgas e assinala dias com menos de 3
  pessoas em qualquer dos turnos; substituir uma escala existente exige
  confirmação.
- Também é possível pedir à IA para gerar o mês completo; a IA pede
  confirmação antes de executar a geração automática.
- A IA abre num balão flutuante em qualquer área do site e permanece na aba
  atual. Pode pedir pelo chat alterações na escala e ações sobre a equipa,
  como adicionar ou remover funcionários; todas as ações pedem confirmação.
- O botão da IA tem um robô animado em CSS, com flutuação, antena, piscar e
  balão de ajuda automático, sem carregar imagens ou bibliotecas externas.
- Alterações manuais ou pedidas à IA podem criar uma exceção, como hora extra
  ou uma folga acima do limite; o site mostra um aviso e exige confirmação.
- Na área **Equipa**, cada pessoa mostra as folgas usadas e quantas ainda tem
  disponíveis no mês.
- Na área **Equipa**, o menu de cada pessoa permite editar nome/função ou
  apagá-la permanentemente. Apagar também elimina os horários e histórico
  associados; a ação exige confirmação e não pode ser anulada. A pesquisa e os
  filtros por função e escala mensal ajudam a encontrar funcionários.

## Exemplos de prompts para a IA
- `João folga dia 23`
- `Rita trabalha de noite no dia 25`
- `Ana está de manhã dia 12; Marco descansa dia 7`
- `Maria e Pedro têm folga no dia 9`
- `Apaga todos os funcionários`
- `Eu quero que apagues todos os funcionários`
- `Apaga toda a equipe`
- `Cria o funcionário André Fernandes e gera o horário dele`
- `Cries um funcionário chamado André Fernandes e cries o horário dele do mês de setembro`

A IA reconhece nomes, turnos e dias, entende a aba atual do site e valida
operações antes de pedir confirmação. Pode navegar, pesquisar/filtrar a equipa,
abrir formulários de funcionário, selecionar o mês da escala, consultar dados,
editar turnos e funcionários, gerar escalas e exportar para Excel/PDF. Ações de
navegação, filtros e exportação não alteram os dados; gravações e eliminações
exigem confirmação. A IA só executa capacidades implementadas e não aceita
pedidos arbitrários para alterar a base de dados, credenciais ou configurações
do sistema.

O interpretador aceita linguagem informal e abreviações comuns, como `tds`,
`funcs`, `eq`, `equipe`, `colaboradores` e `pessoas`, sem exigir uma frase
exata.

A resposta repetida vinha do interpretador local: saudações devolviam sempre
uma frase fixa, e falhas da API caíam novamente nesse interpretador em vez de
mostrar o erro. O fallback foi removido; a indisponibilidade agora é mostrada
honestamente no chat.

No servidor, a integração usa o SDK oficial **`@google/generative-ai`**,
**System Instruction**, histórico limitado às últimas 12 mensagens e **Function
Calling**. O backend permite apenas navegação para `overview`, `schedule` e
`team`, pesquisa, consultas tipadas e preparação de operações suportadas. As
operações pendentes ficam em `ai_action_log` e expiram após 15 minutos; a rota
de confirmação aceita apenas o ID pendente e revalida a sessão do gerente e
as permissões RLS antes de escrever. O browser nunca envia dados livres de
escrita para a rota de confirmação.

Conversas e ações de interface não alteram dados. Criar/editar/apagar
funcionários, alterar um turno/folga e gerar uma escala mensal exigem
confirmação. Apagar um funcionário elimina também os seus registos de escala,
em cascata. A geração semanal e a publicação de horários ainda não estão
suportadas pelo schema/interface atual. As folgas são validadas contra o limite
mensal configurado; regras de disponibilidade e cobertura por função não
existem no schema.

O fuso horário usado para interpretar datas relativas é `APP_TIME_ZONE` (por
omissão `Europe/Lisbon`). O frontend também abre as abas reais existentes,
pesquisa pelo campo `#team-search` e apresenta um formulário de criação sem
gravar até ao envio.

## Testes do assistente

Execute os testes automatizados, sem chamadas reais ao Gemini ou ao Supabase:

```powershell
npm.cmd test
```

Com `.env` configurado e o gerente autenticado, abre **Ajuda IA** e testa:

1. `bom dia` — resposta natural, sem navegação nem alteração.
2. `abre a equipa` — abre a aba Equipa.
3. `vai para horários` — abre Horários.
4. `procura a Rita` — abre Equipa e preenche a pesquisa.
5. `cria a funcionária Ana` — pede confirmação; a pessoa só aparece na base de dados depois de confirmar.
6. `marca folga para a Rita amanhã` — apresenta a data local (Lisboa) e só grava depois de confirmar; pode ser recusado se já tiver atingido o limite de folgas.
7. `remove o Carlos` — pede confirmação e apaga permanentemente o funcionário e os seus registos de escala.
8. Retira temporariamente todas as `GEMINI_API_KEY_1` a `_4` ou interrompe a ligação — o chat deve mostrar indisponibilidade, não uma saudação ou resultado falso.

As chamadas reais de gravação requerem o schema Supabase aplicado, sessão autenticada como proprietária do workspace e configuração válida no `.env`. Os testes automatizados usam respostas simuladas e não alteram dados reais.

As folgas usadas são contadas apenas a partir de registos explícitos `shift = 'off'`
em `schedule_entries` para o funcionário e mês pedidos. Dias da escala predefinida
ou sem atribuição guardada não contam. O cartão da Equipa e a resposta do chat
mostram `X/7 folgas usadas · Y restantes`.

Ao confirmar uma folga, o terminal regista o ID da proposta, se foi encontrada,
o tipo, o UUID do funcionário, a data, o resultado das validações e o estado HTTP.
Em falhas do Supabase, o log inclui `code`, `message`, `details` e `hint`, mas
nunca inclui chaves ou tokens. Propostas com erro de escrita permanecem pendentes
até expirarem, para permitir nova tentativa; propostas expiradas são canceladas.

Os testes automatizados também cobrem funcionário sem folgas explícitas, escala
guardada vazia, limite mensal, repetição na mesma data, expiração, recusa RLS,
tentativa posterior bem-sucedida e continuidade do chat após uma falha.

O schema SQL é seguro para voltar a executar quando os tipos já existem. Se o
Supabase indicar que uma tabela ou política já existe, significa que uma parte
do script já foi aplicada; nesse caso, não apagues dados sem confirmar e envia
o erro seguinte para eu preparar uma migração específica.

Os funcionários, alterações manuais, mês selecionado e estado da escala são
guardados no Supabase. O site não usa `localStorage`; depois do login do
gerente, os dados são carregados e gravados na base de dados.

As datas de alterações de escala são validadas no formato ISO `YYYY-MM-DD`,
incluindo confirmação de que o dia existe no calendário, tanto ao preparar a
proposta da IA como antes de a gravar. O Supabase atualiza `updated_at`, a
coluna `source` distingue a origem `manual`, `automatic` ou `ai`, e a coluna
`updated_by` regista, através de um trigger, o ID do utilizador autenticado que
fez a última alteração, tanto no site como nas alterações da IA. Os registos
anteriores à migração mantêm `updated_by` vazio, pois não é possível inferir
com segurança quem os alterou.

## Supabase

O ficheiro [supabase-schema.sql](./supabase-schema.sql) contém o esquema
completo para migrar a equipa e as escalas para o Supabase. O sistema está
preparado para uma única conta de gerente: os funcionários são registos da
equipa e não precisam de contas ou palavras-passe. No painel do
Supabase, abra **SQL Editor**, cole o conteúdo do ficheiro e execute-o.

O esquema inclui:

- autenticação por utilizador e espaços de trabalho;
- funcionários e estado ativo/inativo;
- meses de escala e células diárias;
- turnos do dia, noite, folga e sem horário;
- hora extra e origem da alteração;
- regras de horários configuráveis;
- histórico de ações estruturadas da IA para permitir desfazer;
- índices, triggers de atualização e Row Level Security.

Crie apenas uma conta em **Authentication > Users** para o gerente. O comando
`create_workspace` usa `auth.uid()`, por isso só funciona numa sessão já
autenticada; executá-lo diretamente no SQL Editor normalmente resulta em
`owner_id is null`.

Para uma instalação Supabase já existente, execute
[supabase-migration-schedule-custom-text.sql](./supabase-migration-schedule-custom-text.sql)
no SQL Editor para ativar os horários personalizados e o registo do utilizador
que alterou cada horário. Esta migração pode ser executada mais do que uma vez.
Para consultar as últimas alterações no SQL Editor:

```sql
select entry.work_date, employee.name, auth_user.email as updated_by,
       entry.updated_at, entry.source
from public.schedule_entries as entry
join public.employees as employee on employee.id = entry.employee_id
left join auth.users as auth_user on auth_user.id = entry.updated_by
order by entry.updated_at desc;
```

Para criar o espaço diretamente no SQL Editor, substitua o email pelo email
exato da conta do gerente e execute:

```sql
do $$
declare
  manager_id uuid;
  new_workspace_id uuid;
begin
  select id into manager_id
  from auth.users
  where email = 'EMAIL-DO-GERENTE@example.com'
  limit 1;

  if manager_id is null then
    raise exception 'Não encontrei esse email em Authentication > Users.';
  end if;

  insert into public.workspaces (name, owner_id)
  values ('Mr Pizza', manager_id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, is_admin)
  values (new_workspace_id, manager_id, true)
  on conflict (workspace_id, user_id) do nothing;

  insert into public.workspace_settings (workspace_id)
  values (new_workspace_id)
  on conflict (workspace_id) do nothing;
end $$;
```

Se o espaço já existir, não executes este bloco novamente. A aplicação entrega
ao SDK do Supabase no browser apenas a chave pública/anon configurada no
servidor; a chave `service_role` não é necessária nem utilizada. É necessário
iniciar sessão com a conta do gerente e ter o espaço de trabalho criado.

## Funcionalidades do calendário
- **Gerar mês** cria a escala completa respeitando as folgas e os turnos configurados.
- **Cobertura do mês** mostra dias equilibrados, equipa média e folgas totais.
- **Excel** descarrega uma tabela profissional formatada, com cores por turno,
  folgas, horários sem preenchimento, data de geração e folgas usadas/restantes,
  pronta para abrir no Excel e enviar aos funcionários.
- **Baixar PDF** gera e descarrega diretamente um PDF horizontal profissional.
  Não abre a janela de impressão do navegador.

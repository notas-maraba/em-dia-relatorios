# Dados e limites de privacidade

## O que este pacote contém

Somente código, documentação e testes com dados fictícios. Não contém os nomes, relatórios reais, arquivos pessoais ou backups do usuário.

## O que é armazenado

Os cadastros de publicadores, períodos de pioneiro, relatórios, lembretes registrados e configurações ficam no armazenamento local do navegador. O aplicativo não inclui serviços de analytics, fontes remotas ou requisições de envio desses registros.

O download do site pelo GitHub Pages envolve normalmente a infraestrutura de hospedagem; a ausência de envio dos relatórios pelo aplicativo não significa ausência de registros técnicos de acesso na hospedagem.

## Limites importantes

- Não há autenticação, criptografia dos registros ou controle individual de permissões.
- Não há sincronização entre aparelhos e nem backup automático remoto.
- Quem utiliza o mesmo perfil de navegador pode ter acesso aos registros.
- Limpeza de dados do navegador, perda do aparelho ou falhas de armazenamento podem causar perda de registros.
- O armazenamento local é separado por origem, não por caminho da URL. Outros aplicativos publicados na mesma origem do GitHub Pages podem compartilhar o acesso técnico ao armazenamento. Utilize apenas código confiável nessa origem.
- A orientação `noindex` presente no HTML não é uma barreira de acesso nem uma garantia de sigilo.
- O arquivo `.gitignore` não protege um arquivo que você enviar deliberadamente pelo navegador, nem remove um arquivo já publicado.

## Procedimento recomendado

Use um aparelho e perfil de navegador sob seu controle. Exporte backups com regularidade e guarde-os em local privado. Não coloque HTML pessoal, JSON de backup, PDFs ou imagens com relatórios no repositório público.

Para migrar para o site publicado, importe o backup dentro da aba **Dados** do aplicativo. Esse processo lê o arquivo localmente; não envia o JSON ao GitHub. A importação substitui a base atual, então preserve uma cópia antes de confirmar.

Para uso simultâneo por várias pessoas, com base compartilhada, esta versão precisará de autenticação, regras de acesso e backend apropriados. Hospedar no Pages, por si só, não acrescenta essas funcionalidades.
